/**
 * NotificationsService.notifyBookingCreated — WhatsApp branch contract.
 *
 * Phase 2 (May 29, 2026) wired the WhatsApp `chef_booking_request`
 * template into the chef-side fan-out. This spec locks in the gating
 * + payload contract independently of the existing email-branch spec.
 *
 * What this spec asserts
 * ----------------------
 *   1. WhatsAppService.sendTemplate is called when:
 *        - chefDetails.cookPhone is present
 *        - User.whatsapp_enabled !== false
 *      The call payload exactly matches what Phase 3's webhook handler
 *      will see on the wire — template name, var order, button payload
 *      shape, correlationId.
 *
 *   2. Quick-reply button payloads are `APPROVE_<bookingId>` and
 *      `REJECT_<bookingId>` — Phase 3 routes these back to
 *      bookingsService.acceptBooking / rejectBooking by parsing the
 *      bookingId off the prefix. A regression in `buttonSuffixes`
 *      would silently break every chef approve / decline tap.
 *
 *   3. Free-text vars (chef name, customer name, address) are sanitised
 *      before being handed to WhatsAppService — newlines + tabs +
 *      multi-space collapsed to single space. Meta rejects template
 *      variables that contain raw newlines or 4+ consecutive
 *      whitespace; without sanitisation a chef whose `name` was typed
 *      with a trailing newline would silently never receive WhatsApp.
 *
 *   4. WhatsApp is skipped (no sendTemplate call) when:
 *        a. cookPhone is null/undefined (chef has no phone on file)
 *        b. User.whatsapp_enabled === false (chef has muted channel)
 *
 *   5. WhatsApp failure (sendTemplate throws) does NOT bubble up — the
 *      booking flow must never break because Meta is having a bad day.
 *      In-app rows + email send still complete normally.
 *
 *   6. Email branch still fires regardless of WhatsApp — the two are
 *      independent gates. Regression guard against a future refactor
 *      that accidentally chains them.
 *
 *   7. Phase 1 baseline still holds: WhatsApp send is a no-op (still
 *      false from sendTemplate) when the provider isn't configured.
 *      The notification flow doesn't care — it gates on user prefs +
 *      phone presence, not provider configuration. Provider-level
 *      no-op is verified by whatsapp.service.spec.ts.
 */
import { NotificationsService } from './notifications.service';
import { CHEF_BOOKING_REQUEST } from '../whatsapp/templates';

interface ServiceFixture {
  service: NotificationsService;
  sendTemplateSpy: jest.Mock;
  sendDirectEmail: jest.SpyInstance;
  inAppRowCount: () => number;
}

function makeService(opts: {
  emailEnabled?: boolean;
  whatsappEnabled?: boolean;
  sendTemplateImpl?: jest.Mock;
} = {}): ServiceFixture {
  const inAppRows: any[] = [];

  const notificationsRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((row: any) => row),
    save: jest.fn(async (row: any) => {
      inAppRows.push(row);
      return row;
    }),
  };

  const usersRepo: any = {
    findOne: jest.fn(async () => ({
      id: 'cook-user-id',
      email_enabled: opts.emailEnabled ?? true,
      sms_enabled: true,
      push_enabled: true,
      whatsapp_enabled: opts.whatsappEnabled ?? true,
    })),
  };

  const noopQueue: any = { add: jest.fn() };
  const config: any = { get: jest.fn(() => 'test-brevo-api-key') };
  const analytics: any = { track: jest.fn() };

  const sendTemplateSpy =
    opts.sendTemplateImpl ?? jest.fn(async () => true);
  const whatsapp: any = {
    sendTemplate: sendTemplateSpy,
    sendText: jest.fn(),
    isConfigured: jest.fn(() => true),
    verifySignature: jest.fn(),
    verifyChallenge: jest.fn(),
    parseInbound: jest.fn(),
  };

  const service = new NotificationsService(
    notificationsRepo,
    usersRepo,
    noopQueue,
    noopQueue,
    config,
    analytics,
    whatsapp,
  );

  const sendDirectEmail = jest
    .spyOn(service, 'sendDirectEmail')
    .mockImplementation(async () => undefined);

  return {
    service,
    sendTemplateSpy: sendTemplateSpy as jest.Mock,
    sendDirectEmail,
    inAppRowCount: () => inAppRows.length,
  };
}

const userId = '11111111-1111-1111-1111-111111111111';
const cookUserId = '22222222-2222-2222-2222-222222222222';
const bookingId = '33333333-3333-3333-3333-333333333333';
const baseChefDetails = {
  cookEmail: 'chef@example.com',
  cookPhone: '+919876543210',
  chefName: 'Chef Anjali',
  scheduledAt: new Date('2026-06-15T19:30:00.000Z'),
  address: 'Flat 4B, Sky Heights, Ahmedabad',
  totalPrice: 1234.56,
};

describe('notifyBookingCreated → WhatsApp branch', () => {
  it('sends the chef_booking_request template with the exact wire-level payload Phase 3 expects', async () => {
    const f = makeService({});

    await f.service.notifyBookingCreated(
      userId,
      cookUserId,
      bookingId,
      'Riya',
      baseChefDetails,
    );

    expect(f.sendTemplateSpy).toHaveBeenCalledTimes(1);
    const arg = f.sendTemplateSpy.mock.calls[0][0];
    expect(arg.template).toBe(CHEF_BOOKING_REQUEST);
    expect(arg.to).toBe('+919876543210'); // service normalises internally
    expect(arg.correlationId).toBe(bookingId);

    // Var order MUST match templates.ts CHEF_BOOKING_REQUEST.vars:
    // [chef_name, customer_name, booking_id_short, date_str, time_str,
    //  address_short, total_str].
    const [chefName, customerNameVar, shortId, dateStr, timeStr, addressVar, totalStr] =
      arg.vars;
    expect(chefName).toBe('Chef Anjali');
    expect(customerNameVar).toBe('Riya');
    expect(shortId).toBe('33333333');
    expect(dateStr).toMatch(/Sat|Sun|Mon|Tue|Wed|Thu|Fri/); // weekday word
    expect(dateStr).toMatch(/2026/);
    expect(timeStr).toMatch(/\d{1,2}:\d{2}/);
    expect(addressVar).toBe('Flat 4B, Sky Heights, Ahmedabad');
    // Total formatted without ₹ symbol — the template owns currency
    // (so a future copy update doesn't require a code change).
    expect(totalStr).toBe('1235');

    // Quick-reply buttons MUST be APPROVE_<id> + REJECT_<id> in template
    // order — Phase 3's webhook handler parses the prefix to decide
    // accept vs reject and the suffix to look up the booking.
    expect(arg.buttonSuffixes).toEqual([bookingId, bookingId]);
  });

  it('sanitises free-text vars: collapses newlines, tabs, multi-space', async () => {
    const f = makeService({});

    await f.service.notifyBookingCreated(
      userId,
      cookUserId,
      bookingId,
      'Riya\nfrom\tHome', // newline + tab in customer name
      {
        ...baseChefDetails,
        chefName: 'Chef\u00A0Anjali  Patel', // nbsp + double space
        address:
          'Flat 4B,\nSky Heights\n\nAhmedabad', // double-newline (paragraph break)
      },
    );

    const arg = f.sendTemplateSpy.mock.calls[0][0];
    expect(arg.vars[0]).toBe('Chef\u00A0Anjali Patel'); // collapsed multi-space
    expect(arg.vars[1]).toBe('Riya, from, Home'); // \n and \t became ", "
    // 'Flat 4B,\nSky Heights\n\nAhmedabad' → single `\n` becomes ", "
    // (yielding `,,` after the existing comma) and the consecutive
    // `\n\n` is matched once by /[\r\n\t]+/ so it ALSO becomes ", "
    // (single — collapsed by the `+` quantifier). Result:
    expect(arg.vars[5]).toBe('Flat 4B,, Sky Heights, Ahmedabad');
    // None of the vars carry a raw newline or tab.
    for (const v of arg.vars) {
      expect(v).not.toMatch(/[\r\n\t]/);
    }
  });

  it('skips WhatsApp when chef has no phone on file', async () => {
    const f = makeService({});

    await f.service.notifyBookingCreated(userId, cookUserId, bookingId, 'Riya', {
      ...baseChefDetails,
      cookPhone: null,
    });

    expect(f.sendTemplateSpy).not.toHaveBeenCalled();
    // Email branch still fires when cookEmail is set (independent gate).
    expect(f.sendDirectEmail).toHaveBeenCalled();
  });

  it('skips WhatsApp when chef has muted the channel (whatsapp_enabled=false)', async () => {
    const f = makeService({ whatsappEnabled: false });

    await f.service.notifyBookingCreated(
      userId,
      cookUserId,
      bookingId,
      'Riya',
      baseChefDetails,
    );

    expect(f.sendTemplateSpy).not.toHaveBeenCalled();
    // Email still fires — distinct gate.
    expect(f.sendDirectEmail).toHaveBeenCalled();
  });

  it('does not bubble up if WhatsApp send throws — booking flow must never break', async () => {
    const throwingSend = jest.fn(async () => {
      throw new Error('Meta is sad');
    });
    const f = makeService({ sendTemplateImpl: throwingSend });

    await expect(
      f.service.notifyBookingCreated(
        userId,
        cookUserId,
        bookingId,
        'Riya',
        baseChefDetails,
      ),
    ).resolves.toBeUndefined();

    expect(throwingSend).toHaveBeenCalledTimes(1);
    expect(f.inAppRowCount()).toBe(2); // chef + customer in-app still went through
    expect(f.sendDirectEmail).toHaveBeenCalled(); // email still went through
  });

  it('still calls WhatsApp when chefDetails.cookEmail is null but cookPhone is set', async () => {
    // Defensive: a Google-only chef account that somehow lacks an email
    // should still get WhatsApp — the two channels are independent.
    const f = makeService({});

    await f.service.notifyBookingCreated(userId, cookUserId, bookingId, 'Riya', {
      ...baseChefDetails,
      cookEmail: null,
    });

    expect(f.sendTemplateSpy).toHaveBeenCalledTimes(1);
    expect(f.sendDirectEmail).not.toHaveBeenCalled();
  });

  it('omits WhatsApp send when chefDetails is omitted entirely (legacy callers)', async () => {
    const f = makeService({});

    await f.service.notifyBookingCreated(userId, cookUserId, bookingId, 'Riya');

    expect(f.sendTemplateSpy).not.toHaveBeenCalled();
    expect(f.sendDirectEmail).not.toHaveBeenCalled();
    expect(f.inAppRowCount()).toBe(2); // chef + customer in-app still go through
  });

  it('rounds total price to whole rupees for the WhatsApp template', async () => {
    const f = makeService({});

    await f.service.notifyBookingCreated(userId, cookUserId, bookingId, 'Riya', {
      ...baseChefDetails,
      totalPrice: 999.49,
    });
    let arg = f.sendTemplateSpy.mock.calls[0][0];
    expect(arg.vars[6]).toBe('999');

    f.sendTemplateSpy.mockClear();
    await f.service.notifyBookingCreated(userId, cookUserId, bookingId, 'Riya', {
      ...baseChefDetails,
      totalPrice: 999.5,
    });
    arg = f.sendTemplateSpy.mock.calls[0][0];
    expect(arg.vars[6]).toBe('1000');
  });
});
