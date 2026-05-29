/**
 * WhatsAppWebhookService — inbound routing contract.
 *
 * What this spec locks in
 * -----------------------
 *
 *   1. Button payloads `APPROVE_<id>` / `REJECT_<id>` route to the
 *      correct BookingsService method (.acceptBooking / .rejectBooking)
 *      with the chef's user_id, identified by their inbound WhatsApp
 *      phone.
 *
 *   2. Idempotency: the second delivery of the same wamid is a complete
 *      no-op (no second BookingsService call, no second Redis claim).
 *      Meta retries inbound deliveries on any non-2xx response within
 *      ~30s; the 5-minute TTL is comfortably wider than that window.
 *
 *   3. Status / delivery / read receipts are silently ignored (Phase 5
 *      will use them — Phase 3 just doesn't crash on them).
 *
 *   4. Free-text inbound messages are logged but don't trigger any
 *      state mutation. The chef trying to converse with the platform
 *      (asking a question, complaining) doesn't move bookings around.
 *
 *   5. Inbound from a phone with NO matching chef user is dropped
 *      with a warning. Inbound from a phone that matches MULTIPLE
 *      chefs is also dropped — ambiguous identity is the same threat
 *      class as no identity. NEVER guess.
 *
 *   6. Race-safe state mutation: when BookingsService throws (booking
 *      already CONFIRMED, expired, cancelled, etc.) we catch the
 *      error, log it, and (when WhatsApp is configured) reply with a
 *      friendly text in the 24h customer-care window. The booking
 *      state never wobbles.
 *
 *   7. parseButtonPayload — pure function, all the edge cases:
 *      legitimate APPROVE_<id> + REJECT_<id>, surrounding whitespace,
 *      case-sensitive prefix, unknown prefixes, empty payload.
 *
 * Why these tests matter
 * ----------------------
 * The HMAC verification at the controller IS the auth boundary. By the
 * time this service sees an event we trust the bytes came from Meta,
 * but the routing logic still has to:
 *   - resolve a chef identity from a phone (without matching the wrong
 *     chef and giving them control over someone else's bookings),
 *   - dedupe Meta's retries,
 *   - never let an invariant violation in BookingsService crash the
 *     webhook (Meta would retry forever).
 *
 * A regression in any of these is exploitable. Hence: aggressive
 * coverage.
 */
import { WhatsAppWebhookService } from './whatsapp-webhook.service';
import { InboundEvent } from './providers/whatsapp.provider.interface';

interface ServiceFixture {
  service: WhatsAppWebhookService;
  parseInbound: jest.Mock;
  acceptBooking: jest.Mock;
  rejectBooking: jest.Mock;
  setIfNotExists: jest.Mock;
  sendText: jest.Mock;
  isConfigured: jest.Mock;
  setChefMatches: (matches: any[]) => void;
}

function makeFixture(opts: {
  cacheClaims?: boolean; // default true (claims succeed)
  whatsappConfigured?: boolean; // default true
} = {}): ServiceFixture & { qb: { andWhere: jest.Mock; where: jest.Mock; getMany: jest.Mock } } {
  let chefMatches: any[] = [];

  // Minimal QueryBuilder mock that returns the configured chef matches.
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => chefMatches),
  };
  const usersRepo: any = {
    createQueryBuilder: jest.fn(() => qb),
  };

  const acceptBooking = jest.fn(async () => undefined);
  const rejectBooking = jest.fn(async () => undefined);
  const bookingsService: any = { acceptBooking, rejectBooking };

  const setIfNotExists = jest.fn(async () => opts.cacheClaims ?? true);
  const cache: any = { setIfNotExists };

  const parseInbound = jest.fn(() => [] as InboundEvent[]);
  const sendText = jest.fn(async () => true);
  const isConfigured = jest.fn(() => opts.whatsappConfigured ?? true);
  const whatsapp: any = {
    parseInbound,
    sendText,
    isConfigured,
    sendTemplate: jest.fn(),
    verifySignature: jest.fn(),
    verifyChallenge: jest.fn(),
  };

  const service = new WhatsAppWebhookService(
    usersRepo,
    bookingsService,
    cache,
    whatsapp,
  );

  return {
    service,
    qb,
    parseInbound,
    acceptBooking,
    rejectBooking,
    setIfNotExists,
    sendText,
    isConfigured,
    setChefMatches: (m) => {
      chefMatches = m;
    },
  };
}

const BOOKING_ID = '33333333-3333-3333-3333-333333333333';
const CHEF_USER_ID = 'cook-user-uuid';
const CHEF_PHONE_E164 = '919876543210';

const button = (payload: string, id = 'wamid.1'): InboundEvent => ({
  providerMessageId: id,
  from: CHEF_PHONE_E164,
  type: 'button',
  buttonPayload: payload,
});

describe('WhatsAppWebhookService.parseButtonPayload (static)', () => {
  it('accepts APPROVE_<id>', () => {
    expect(
      WhatsAppWebhookService.parseButtonPayload(`APPROVE_${BOOKING_ID}`),
    ).toEqual({ kind: 'approve', bookingId: BOOKING_ID });
  });

  it('accepts REJECT_<id>', () => {
    expect(
      WhatsAppWebhookService.parseButtonPayload(`REJECT_${BOOKING_ID}`),
    ).toEqual({ kind: 'reject', bookingId: BOOKING_ID });
  });

  it('tolerates surrounding whitespace', () => {
    expect(
      WhatsAppWebhookService.parseButtonPayload(`  APPROVE_${BOOKING_ID}  `),
    ).toEqual({ kind: 'approve', bookingId: BOOKING_ID });
  });

  it.each<string | undefined>([
    undefined,
    '',
    'APPROVE',
    'approve_id', // case-sensitive — Meta always normalises
    'APPROVED_id',
    'GIBBERISH',
    'APPROVE_', // empty bookingId
  ])('refuses %j', (payload) => {
    if (payload === 'APPROVE_') {
      // Empty bookingId after the prefix is technically still parsable
      // by the regex — the consequence is bookingsService throwing
      // NotFoundException downstream. Our regex requires at least 1
      // character; '/^APPROVE_(.+)$/' returns null for 'APPROVE_'.
      expect(WhatsAppWebhookService.parseButtonPayload(payload)).toBeNull();
      return;
    }
    expect(WhatsAppWebhookService.parseButtonPayload(payload)).toBeNull();
  });
});

describe('WhatsAppWebhookService.handle — APPROVE button routing', () => {
  it('routes to bookingsService.acceptBooking when chef matches', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([button(`APPROVE_${BOOKING_ID}`)]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '+91 98765 43210' }]);

    await f.service.handle({});

    expect(f.acceptBooking).toHaveBeenCalledWith(BOOKING_ID, CHEF_USER_ID);
    expect(f.rejectBooking).not.toHaveBeenCalled();
    expect(f.sendText).not.toHaveBeenCalled();
  });

  it('claims the dedupe key BEFORE invoking bookingsService', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([button(`APPROVE_${BOOKING_ID}`, 'wamid.X')]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '919876543210' }]);

    await f.service.handle({});

    expect(f.setIfNotExists).toHaveBeenCalledWith(
      'whatsapp:inbound:wamid.X',
      expect.objectContaining({ from: CHEF_PHONE_E164, type: 'button' }),
      300, // 5 min TTL
    );
    // Order check — claim must precede the side-effect.
    const claimOrder = (f.setIfNotExists.mock.invocationCallOrder[0]) as number;
    const acceptOrder = (f.acceptBooking.mock.invocationCallOrder[0]) as number;
    expect(claimOrder).toBeLessThan(acceptOrder);
  });

  it('drops on duplicate wamid (Redis SET-NX returns false)', async () => {
    const f = makeFixture({ cacheClaims: false });
    f.parseInbound.mockReturnValue([button(`APPROVE_${BOOKING_ID}`)]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '919876543210' }]);

    await f.service.handle({});

    expect(f.acceptBooking).not.toHaveBeenCalled();
    expect(f.rejectBooking).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebhookService.handle — REJECT button routing', () => {
  it('routes to bookingsService.rejectBooking with default WhatsApp reason', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([button(`REJECT_${BOOKING_ID}`)]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '+919876543210' }]);

    await f.service.handle({});

    expect(f.rejectBooking).toHaveBeenCalledTimes(1);
    expect(f.rejectBooking).toHaveBeenCalledWith(BOOKING_ID, CHEF_USER_ID, {
      reason: 'Declined via WhatsApp',
    });
    expect(f.acceptBooking).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebhookService.handle — chef identity', () => {
  it('refuses when the inbound phone matches NO chef', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([button(`APPROVE_${BOOKING_ID}`)]);
    f.setChefMatches([]); // no match

    await f.service.handle({});

    expect(f.acceptBooking).not.toHaveBeenCalled();
    expect(f.rejectBooking).not.toHaveBeenCalled();
  });

  it('refuses when the inbound phone matches MULTIPLE chefs (ambiguous)', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([button(`APPROVE_${BOOKING_ID}`)]);
    f.setChefMatches([
      { id: 'chef-a', phone: '9876543210' },
      { id: 'chef-b', phone: '+91 98765 43210' },
    ]);

    await f.service.handle({});

    expect(f.acceptBooking).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebhookService.handle — non-button events', () => {
  it('silently ignores status / delivery receipts', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([
      {
        providerMessageId: 'wamid.S',
        from: CHEF_PHONE_E164,
        type: 'status',
      },
    ]);

    await f.service.handle({});

    // Critical: NO Redis claim should happen for status events. They
    // arrive at high volume (every read receipt, every delivered tick)
    // and burning Redis writes on them is wasted I/O.
    expect(f.setIfNotExists).not.toHaveBeenCalled();
    expect(f.acceptBooking).not.toHaveBeenCalled();
  });

  it('logs free-text inbound but does not mutate state', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([
      {
        providerMessageId: 'wamid.T',
        from: CHEF_PHONE_E164,
        type: 'text',
        text: 'help me',
      },
    ]);

    await f.service.handle({});

    // Text events DO go through dedup (so the chef sending the same
    // message twice doesn't double-log).
    expect(f.setIfNotExists).toHaveBeenCalledTimes(1);
    expect(f.acceptBooking).not.toHaveBeenCalled();
  });

  it('drops unknown payload prefixes without crashing', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([button('UNKNOWN_PAYLOAD_xxx')]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '919876543210' }]);

    await f.service.handle({});

    expect(f.acceptBooking).not.toHaveBeenCalled();
    expect(f.rejectBooking).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebhookService.handle — race-safe error handling', () => {
  it('catches BookingsService.acceptBooking errors and replies via WhatsApp text', async () => {
    const f = makeFixture({});
    f.acceptBooking.mockRejectedValue(
      new Error('Cannot accept a booking in status "confirmed"'),
    );
    f.parseInbound.mockReturnValue([button(`APPROVE_${BOOKING_ID}`)]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '919876543210' }]);

    await expect(f.service.handle({})).resolves.toBeUndefined();

    expect(f.sendText).toHaveBeenCalledTimes(1);
    const [to, body, corr] = f.sendText.mock.calls[0];
    expect(to).toBe(CHEF_PHONE_E164);
    expect(body).toMatch(/already been actioned|expired|cancelled/i);
    expect(corr).toBe(BOOKING_ID);
  });

  it('does NOT send text reply when WhatsApp provider is unconfigured', async () => {
    const f = makeFixture({ whatsappConfigured: false });
    f.acceptBooking.mockRejectedValue(new Error('any error'));
    f.parseInbound.mockReturnValue([button(`APPROVE_${BOOKING_ID}`)]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '919876543210' }]);

    await f.service.handle({});

    expect(f.sendText).not.toHaveBeenCalled();
  });

  it('catches REJECT errors symmetrically', async () => {
    const f = makeFixture({});
    f.rejectBooking.mockRejectedValue(new Error('expired'));
    f.parseInbound.mockReturnValue([button(`REJECT_${BOOKING_ID}`)]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '919876543210' }]);

    await expect(f.service.handle({})).resolves.toBeUndefined();
    expect(f.sendText).toHaveBeenCalledTimes(1);
  });

  it('continues processing later events when an earlier one throws', async () => {
    const f = makeFixture({});
    f.acceptBooking.mockRejectedValueOnce(new Error('boom'));
    f.parseInbound.mockReturnValue([
      button(`APPROVE_${BOOKING_ID}`, 'wamid.1'),
      button(`REJECT_${BOOKING_ID}`, 'wamid.2'),
    ]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '919876543210' }]);

    await f.service.handle({});

    // First event errored (caught + reply sent), second event ran.
    expect(f.acceptBooking).toHaveBeenCalledTimes(1);
    expect(f.rejectBooking).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsAppWebhookService.handle — query shape', () => {
  it('builds the chef-by-phone query with the LAST 10 digits as the LIKE pattern', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([button(`APPROVE_${BOOKING_ID}`)]);
    f.setChefMatches([{ id: CHEF_USER_ID, phone: '919876543210' }]);

    await f.service.handle({});

    // The QueryBuilder mock collapses to one chained createQueryBuilder
    // → where → andWhere → andWhere → getMany call. Verify the LIKE
    // pattern uses the last 10 digits of the inbound E.164 number —
    // catches the most common regression: hard-coding the entire E.164
    // string into the LIKE pattern, which would fail to match users
    // whose phone is stored without the country code.
    const lastWhere = f.qb.andWhere.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('regexp_replace'),
    );
    expect(lastWhere).toBeDefined();
    expect(lastWhere![1].pattern).toBe('%9876543210');
  });

  it('skips the lookup entirely when from is not 10+ digits', async () => {
    const f = makeFixture({});
    f.parseInbound.mockReturnValue([
      {
        providerMessageId: 'wamid.X',
        from: '12345', // too short
        type: 'button',
        buttonPayload: `APPROVE_${BOOKING_ID}`,
      },
    ]);

    await f.service.handle({});

    // Nothing should reach BookingsService; chef lookup returns null
    // because the digits-only form is < 10 chars.
    expect(f.acceptBooking).not.toHaveBeenCalled();
  });
});
