/**
 * MetaCloudWhatsAppProvider — security + payload contract.
 *
 * What this spec locks in
 * -----------------------
 *
 *   1. `isConfigured()` is the single source of truth used by every
 *      caller to decide whether to short-circuit. It must return
 *      true ONLY when ALL FOUR required env vars are present —
 *      missing any one is a no-op. This is what makes Phase 1
 *      ship-able before WABA credentials are provisioned.
 *
 *   2. `verifySignature()` mirrors PaymentsService's Razorpay HMAC
 *      contract:
 *        a. Refuses if app secret env is missing (loud, not silent).
 *        b. Refuses if signature header is missing.
 *        c. Refuses if raw body is missing or empty.
 *        d. Refuses on byte mismatch (length-equal but wrong bytes).
 *        e. Refuses on length mismatch — without throwing
 *           (timingSafeEqual throws on different buffer lengths;
 *            we wrap to return false instead).
 *        f. Accepts a valid signature with EITHER 'sha256=' prefix
 *           or just the bare hex digest.
 *
 *   3. `verifyChallenge()` returns the challenge string when
 *      hub.mode='subscribe' AND hub.verify_token matches the
 *      configured value. Returns null on any other shape.
 *
 *   4. `parseInbound()` extracts the right events out of Meta's
 *      nested entry/changes/value/messages payload — including
 *      legacy 'button' messages, modern 'interactive.button_reply'
 *      messages, plain text, and status/delivery receipts. Tolerates
 *      malformed payloads (returns []).
 *
 * Background — why HMAC verification is the security boundary
 * -----------------------------------------------------------
 * Phase 3 will route inbound webhook button payloads
 * ('APPROVE_<bookingId>') to BookingsService.acceptBooking — i.e.
 * change booking state without a JWT. The signature check is the
 * ONLY thing that proves the request actually came from Meta. A
 * missed corner case here means anyone on the internet can flip
 * any chef's bookings to CONFIRMED. Hence: tested aggressively.
 */
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { MetaCloudWhatsAppProvider } from './meta-cloud.provider';

function makeProvider(env: Record<string, string | undefined> = {}) {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new MetaCloudWhatsAppProvider(config);
}

describe('MetaCloudWhatsAppProvider.isConfigured', () => {
  const fullEnv = {
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    WHATSAPP_ACCESS_TOKEN: 'EAAG...token',
    WHATSAPP_VERIFY_TOKEN: 'random-verify',
    WHATSAPP_APP_SECRET: 'app-secret-bytes',
  };

  it('true when all four required vars are set', () => {
    expect(makeProvider(fullEnv).isConfigured()).toBe(true);
  });

  it.each(Object.keys(fullEnv))('false when %s is missing', (missing) => {
    const env = { ...fullEnv, [missing]: undefined };
    expect(makeProvider(env).isConfigured()).toBe(false);
  });

  it('false when env is empty', () => {
    expect(makeProvider({}).isConfigured()).toBe(false);
  });
});

describe('MetaCloudWhatsAppProvider.verifySignature', () => {
  const APP_SECRET = 'super-secret-app-key';
  const provider = makeProvider({
    WHATSAPP_PHONE_NUMBER_ID: 'pid',
    WHATSAPP_ACCESS_TOKEN: 'tok',
    WHATSAPP_VERIFY_TOKEN: 'verify',
    WHATSAPP_APP_SECRET: APP_SECRET,
  });

  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const validHex = crypto
    .createHmac('sha256', APP_SECRET)
    .update(body)
    .digest('hex');

  it('accepts the signature with sha256= prefix', () => {
    expect(provider.verifySignature(body, `sha256=${validHex}`)).toBe(true);
  });

  it('accepts a bare hex digest (no prefix)', () => {
    expect(provider.verifySignature(body, validHex)).toBe(true);
  });

  it('refuses when signature is missing', () => {
    expect(provider.verifySignature(body, undefined)).toBe(false);
    expect(provider.verifySignature(body, '')).toBe(false);
  });

  it('refuses when raw body is missing', () => {
    expect(provider.verifySignature(undefined, `sha256=${validHex}`)).toBe(false);
    expect(provider.verifySignature(Buffer.alloc(0), `sha256=${validHex}`)).toBe(false);
  });

  it('refuses on byte mismatch (same length, different bytes)', () => {
    const flipped = validHex.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    expect(provider.verifySignature(body, `sha256=${flipped}`)).toBe(false);
  });

  it('refuses on length mismatch WITHOUT throwing', () => {
    // timingSafeEqual throws on mismatched buffer lengths. Wrap MUST
    // catch and return false — never bubble.
    expect(() =>
      provider.verifySignature(body, 'sha256=deadbeef'),
    ).not.toThrow();
    expect(provider.verifySignature(body, 'sha256=deadbeef')).toBe(false);
  });

  it('refuses on garbage hex (non-hex characters)', () => {
    expect(() =>
      provider.verifySignature(body, 'sha256=not-actually-hex'),
    ).not.toThrow();
    expect(provider.verifySignature(body, 'sha256=not-actually-hex')).toBe(false);
  });

  it('refuses (and does not crash) when WHATSAPP_APP_SECRET env is unset', () => {
    const noSecret = makeProvider({
      WHATSAPP_PHONE_NUMBER_ID: 'pid',
      WHATSAPP_ACCESS_TOKEN: 'tok',
      WHATSAPP_VERIFY_TOKEN: 'verify',
      WHATSAPP_APP_SECRET: undefined, // intentionally absent
    });
    expect(noSecret.verifySignature(body, `sha256=${validHex}`)).toBe(false);
  });
});

describe('MetaCloudWhatsAppProvider.verifyChallenge', () => {
  const VERIFY_TOKEN = 'random-verify-token';
  const provider = makeProvider({
    WHATSAPP_PHONE_NUMBER_ID: 'pid',
    WHATSAPP_ACCESS_TOKEN: 'tok',
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: 'app-secret',
  });

  it('returns the challenge string on a valid handshake', () => {
    expect(
      provider.verifyChallenge({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'echo-this-back',
      }),
    ).toBe('echo-this-back');
  });

  it('returns null on token mismatch', () => {
    expect(
      provider.verifyChallenge({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': 'x',
      }),
    ).toBeNull();
  });

  it('returns null on wrong mode', () => {
    expect(
      provider.verifyChallenge({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': 'x',
      }),
    ).toBeNull();
  });

  it('returns null when challenge is missing', () => {
    expect(
      provider.verifyChallenge({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
      }),
    ).toBeNull();
  });
});

describe('MetaCloudWhatsAppProvider.parseInbound', () => {
  const provider = makeProvider({
    WHATSAPP_PHONE_NUMBER_ID: 'pid',
    WHATSAPP_ACCESS_TOKEN: 'tok',
    WHATSAPP_VERIFY_TOKEN: 'verify',
    WHATSAPP_APP_SECRET: 'secret',
  });

  it('extracts a button-tap event', () => {
    const events = provider.parseInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                messages: [
                  {
                    from: '919876543210',
                    id: 'wamid.HBgL1234',
                    timestamp: '1717000000',
                    type: 'button',
                    button: {
                      payload: 'APPROVE_booking-uuid-1',
                      text: 'Approve',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(events).toEqual([
      {
        providerMessageId: 'wamid.HBgL1234',
        from: '919876543210',
        type: 'button',
        buttonPayload: 'APPROVE_booking-uuid-1',
        timestamp: '1717000000',
      },
    ]);
  });

  it('extracts an interactive.button_reply event (modern shape) as type=button', () => {
    const events = provider.parseInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '919876543210',
                    id: 'wamid.X',
                    timestamp: '1',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: {
                        id: 'REJECT_booking-uuid-1',
                        title: 'Decline',
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'button',
      buttonPayload: 'REJECT_booking-uuid-1',
    });
  });

  it('extracts a free-text message', () => {
    const events = provider.parseInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '919876543210',
                    id: 'wamid.T',
                    timestamp: '1',
                    type: 'text',
                    text: { body: 'cant come tomorrow' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      {
        providerMessageId: 'wamid.T',
        from: '919876543210',
        type: 'text',
        text: 'cant come tomorrow',
        timestamp: '1',
      },
    ]);
  });

  it('extracts delivery / read status receipts as type=status', () => {
    const events = provider.parseInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'wamid.S',
                    recipient_id: '919876543210',
                    status: 'delivered',
                    timestamp: '1',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      {
        providerMessageId: 'wamid.S',
        from: '919876543210',
        type: 'status',
        timestamp: '1',
      },
    ]);
  });

  it('returns [] for the wrong object discriminator', () => {
    expect(
      provider.parseInbound({
        object: 'instagram',
        entry: [],
      }),
    ).toEqual([]);
  });

  it('returns [] for completely malformed input without throwing', () => {
    expect(provider.parseInbound(null)).toEqual([]);
    expect(provider.parseInbound(undefined)).toEqual([]);
    expect(provider.parseInbound('not an object')).toEqual([]);
    expect(provider.parseInbound({ entry: 'not-an-array' })).toEqual([]);
  });

  it('marks unknown message types as type=unknown (so the webhook can ack)', () => {
    const events = provider.parseInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '919876543210',
                    id: 'wamid.U',
                    timestamp: '1',
                    type: 'image',
                    image: { mime_type: 'image/jpeg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([
      {
        providerMessageId: 'wamid.U',
        from: '919876543210',
        type: 'unknown',
        timestamp: '1',
      },
    ]);
  });
});

describe('MetaCloudWhatsAppProvider.send (no-op when unconfigured)', () => {
  it('returns ok=false NOT_CONFIGURED without making a network call', async () => {
    const provider = makeProvider({}); // empty env
    const result = await provider.send({
      kind: 'text',
      to: '919876543210',
      body: 'hello',
    });
    expect(result.ok).toBe(false);
    expect(result.providerMessageId).toBeNull();
    expect(result.error?.code).toBe('NOT_CONFIGURED');
  });
});
