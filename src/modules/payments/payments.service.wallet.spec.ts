/**
 * PaymentsService.payFromWallet — money-safety unit spec.
 *
 * Verifies the hardened, transactional pay-from-wallet path:
 *   1. Happy path — no prior payment, sufficient balance: wallet is
 *      debited inside the transaction and a CAPTURED payment is written.
 *   2. Idempotency — a payment already CAPTURED for the booking aborts
 *      with "already completed" and NEVER debits the wallet (this is the
 *      guard that stops a double-tap / retry from charging twice).
 *   3. Insufficient balance — the debit throws and no payment is written.
 *   4. A per-booking advisory lock is taken before the payment is read,
 *      so concurrent requests serialize.
 *
 * Pure unit test: the DataSource transaction is faked to run the callback
 * against in-memory repositories, so we exercise the real control flow.
 */
import { BadRequestException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentStatus } from './payment.entity';
import { BookingStatus } from '../bookings/booking.entity';

function makeService(opts: {
  booking?: any;
  existingPayment?: any;
  insufficient?: boolean;
}) {
  const booking =
    opts.booking ?? {
      id: 'bbbbbbbb-0000-0000-0000-000000000000',
      user_id: 'u1',
      status: BookingStatus.CONFIRMED,
      total_price: 500,
      subtotal: 500,
      platform_fee: 12.5,
    };

  const bookingsRepo: any = { findOne: jest.fn().mockResolvedValue(booking) };
  const paymentsRepo: any = {};
  const cfg: any = {
    get: jest.fn((k: string) =>
      k === 'RAZORPAY_KEY_ID'
        ? 'rzp_test_dummy'
        : k === 'RAZORPAY_KEY_SECRET'
          ? 'dummy_secret'
          : undefined,
    ),
  };
  const notif: any = {};

  const debitWithManager = jest.fn(async () => {
    if (opts.insufficient) {
      throw new BadRequestException('Insufficient wallet balance');
    }
    return { id: 'wtxn' };
  });
  const wallet: any = { debitWithManager, creditWithManager: jest.fn() };

  const saved: any[] = [];
  const queryCalls: any[] = [];
  const mgrPaymentRepo = {
    findOne: jest.fn().mockResolvedValue(opts.existingPayment ?? null),
    create: (x: any) => x,
    save: jest.fn(async (x: any) => {
      const row = { id: 'pay1', ...x };
      saved.push(row);
      return row;
    }),
  };
  const mgrBookingRepo = { update: jest.fn() };
  const mgr = {
    query: jest.fn(async (...a: any[]) => {
      queryCalls.push(a);
      return [];
    }),
    getRepository: (entity: any) =>
      entity && entity.name === 'Booking' ? mgrBookingRepo : mgrPaymentRepo,
  };
  const dataSource: any = {
    transaction: async (cb: any) => cb(mgr),
  };

  const service = new PaymentsService(
    paymentsRepo,
    bookingsRepo,
    cfg,
    notif,
    wallet,
    dataSource,
  );
  return { service, debitWithManager, mgrPaymentRepo, mgrBookingRepo, saved, queryCalls };
}

const BOOKING_ID = 'bbbbbbbb-0000-0000-0000-000000000000';

describe('PaymentsService.payFromWallet', () => {
  it('debits the wallet and writes a CAPTURED payment (happy path)', async () => {
    const { service, debitWithManager, saved, queryCalls } = makeService({});
    const res = await service.payFromWallet('u1', BOOKING_ID);
    expect(res).toMatchObject({ success: true, method: 'wallet', booking_id: BOOKING_ID });
    expect(debitWithManager).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe(PaymentStatus.CAPTURED);
    expect(saved[0].amount).toBe(500);
    expect(saved[0].cook_payout).toBe(500 - 12.5);
    // Advisory lock taken before anything else.
    expect(queryCalls[0][0]).toMatch(/pg_advisory_xact_lock/);
  });

  it('is idempotent: aborts and never debits when already CAPTURED', async () => {
    const { service, debitWithManager, saved } = makeService({
      existingPayment: { id: 'pay1', status: PaymentStatus.CAPTURED },
    });
    await expect(service.payFromWallet('u1', BOOKING_ID)).rejects.toThrow(
      /already completed/i,
    );
    expect(debitWithManager).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('does not write a payment when the balance is insufficient', async () => {
    const { service, saved } = makeService({ insufficient: true });
    await expect(service.payFromWallet('u1', BOOKING_ID)).rejects.toThrow(
      /Insufficient wallet balance/i,
    );
    expect(saved).toHaveLength(0);
  });

  it('rejects a booking in a non-payable status before touching the wallet', async () => {
    const { service, debitWithManager } = makeService({
      booking: {
        id: BOOKING_ID,
        user_id: 'u1',
        status: BookingStatus.COMPLETED,
        total_price: 500,
        subtotal: 500,
        platform_fee: 12.5,
      },
    });
    await expect(service.payFromWallet('u1', BOOKING_ID)).rejects.toThrow(
      /cannot be paid/i,
    );
    expect(debitWithManager).not.toHaveBeenCalled();
  });
});
