/**
 * PaymentsService — webhook HMAC unit tests
 *
 * Locks in the security guards documented at handleWebhook():
 *   1. Refuses if RAZORPAY_WEBHOOK_SECRET env is not configured.
 *   2. Refuses if the signature header is missing.
 *   3. Refuses if the raw body is empty / undefined.
 *   4. Refuses on signature mismatch (same length, wrong bytes).
 *   5. Refuses on signature length mismatch — without throwing
 *      a TypeError from crypto.timingSafeEqual (timing-leak guard).
 *   6. Accepts a valid signature and returns { status: 'ok' }.
 *
 * Pure unit test — no DB, no HTTP, no Razorpay SDK calls. Repositories
 * and NotificationsService are stubbed because the failure paths exit
 * before any of them are touched, and the success path we exercise
 * uses an unrecognized event so the switch statement falls through to
 * the default "log and continue" branch.
 */
import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';

const SECRET = 'test-webhook-secret-do-not-use-in-prod';

function sign(rawBody: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function makeService(opts: { secret?: string | null } = {}) {
  // Stubs that mimic the constructor-injected dependencies but never
  // need to behave realistically for these tests.
  const noopRepo: any = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const noopNotif: any = {
    notifyBookingConfirmed: jest.fn(),
    notifyPaymentReceived: jest.fn(),
  };

  // Defer to the caller's secret choice; default to the valid one.
  const resolvedSecret =
    opts.secret === undefined
      ? SECRET
      : opts.secret === null
        ? undefined
        : opts.secret;

  const cfg: any = {
    get: jest.fn((key: string) => {
      switch (key) {
        case 'RAZORPAY_WEBHOOK_SECRET':
          return resolvedSecret;
        case 'RAZORPAY_KEY_ID':
          return 'rzp_test_dummy';
        case 'RAZORPAY_KEY_SECRET':
          return 'dummy_secret';
        default:
          return undefined;
      }
    }),
  };

  // WalletService — only exercised by payFromWallet, not these specs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noopWallet = { debit: jest.fn(), credit: jest.fn(), getBalance: jest.fn() } as any;
  return new PaymentsService(noopRepo, noopRepo, cfg, noopNotif, noopWallet);
}

describe('PaymentsService.handleWebhook (HMAC verification)', () => {
  it('throws when RAZORPAY_WEBHOOK_SECRET is not configured', async () => {
    const svc = makeService({ secret: null });
    const rawBody = Buffer.from('{}');
    await expect(svc.handleWebhook(rawBody, {}, 'sig')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.handleWebhook(rawBody, {}, 'sig')).rejects.toThrow(
      /Webhook is not configured/i,
    );
  });

  it('throws when RAZORPAY_WEBHOOK_SECRET is the empty string', async () => {
    const svc = makeService({ secret: '' });
    const rawBody = Buffer.from('{}');
    await expect(svc.handleWebhook(rawBody, {}, 'sig')).rejects.toThrow(
      /Webhook is not configured/i,
    );
  });

  it('throws when signature header is missing or empty', async () => {
    const svc = makeService();
    const rawBody = Buffer.from('{}');
    await expect(
      svc.handleWebhook(rawBody, {}, '' as string),
    ).rejects.toThrow(/Missing webhook signature/i);
    await expect(
      svc.handleWebhook(rawBody, {}, undefined as unknown as string),
    ).rejects.toThrow(/Missing webhook signature/i);
  });

  it('throws when the raw body is empty or undefined', async () => {
    const svc = makeService();
    await expect(
      svc.handleWebhook(Buffer.alloc(0), {}, 'somehex'),
    ).rejects.toThrow(/Empty webhook body/i);
    await expect(
      svc.handleWebhook(undefined, {}, 'somehex'),
    ).rejects.toThrow(/Empty webhook body/i);
  });

  it('rejects a tampered signature of the correct length', async () => {
    const svc = makeService();
    const bodyObj = { event: 'payment.captured', payload: {} };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const valid = sign(rawBody, SECRET);
    // Flip the first hex char so the signature stays the same length
    // (64 hex chars) but the bytes differ — this exercises the
    // timingSafeEqual *byte-mismatch* path, not the length-mismatch one.
    const tampered = (valid[0] === '0' ? '1' : '0') + valid.slice(1);
    expect(tampered.length).toBe(valid.length);
    expect(tampered).not.toBe(valid);
    await expect(svc.handleWebhook(rawBody, bodyObj, tampered)).rejects.toThrow(
      /Invalid webhook signature/i,
    );
  });

  it('rejects a signature of the wrong length without throwing TypeError', async () => {
    const svc = makeService();
    const bodyObj = { event: 'payment.captured', payload: {} };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    // crypto.timingSafeEqual throws TypeError if buffers differ in length.
    // The implementation guards against that and must surface the failure
    // as a BadRequestException, not a TypeError.
    await expect(svc.handleWebhook(rawBody, bodyObj, 'short')).rejects.toThrow(
      /Invalid webhook signature/i,
    );
    await expect(svc.handleWebhook(rawBody, bodyObj, 'short')).rejects.not.toThrow(
      TypeError,
    );
  });

  it('rejects a signature computed with a different secret', async () => {
    const svc = makeService();
    const bodyObj = { event: 'payment.captured', payload: {} };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const wrongSig = sign(rawBody, 'a-different-secret');
    await expect(svc.handleWebhook(rawBody, bodyObj, wrongSig)).rejects.toThrow(
      /Invalid webhook signature/i,
    );
  });

  it('rejects a signature computed against a different body', async () => {
    const svc = makeService();
    const realBody = Buffer.from(
      JSON.stringify({ event: 'payment.captured', payload: { amount: 100 } }),
    );
    const fakeBody = Buffer.from(
      JSON.stringify({ event: 'payment.captured', payload: { amount: 1 } }),
    );
    // Compute a valid signature for the *fake* body, then submit it
    // alongside the *real* body. This is the canonical attack we're
    // defending against: a signature that's mathematically valid but
    // attached to substituted content.
    const sigForFakeBody = sign(fakeBody, SECRET);
    await expect(
      svc.handleWebhook(realBody, JSON.parse(realBody.toString()), sigForFakeBody),
    ).rejects.toThrow(/Invalid webhook signature/i);
  });

  it('accepts a valid signature for an unknown event and returns ok', async () => {
    const svc = makeService();
    // Use an event name that no switch case handles, so we never touch
    // the (stubbed) repositories or NotificationsService — the test
    // stays a pure HMAC + control-flow check.
    const bodyObj = { event: 'unhandled.event.for.test', payload: {} };
    const rawBody = Buffer.from(JSON.stringify(bodyObj));
    const valid = sign(rawBody, SECRET);
    const result = await svc.handleWebhook(rawBody, bodyObj, valid);
    expect(result).toEqual({ status: 'ok' });
  });
});
