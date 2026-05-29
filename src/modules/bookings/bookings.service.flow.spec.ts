/**
 * BookingsService — booking-flow regression spec
 *
 * Locks in the customer-facing flow change from
 * `feat/booking-flow-confirmed-after-chef-accept`:
 *
 *   Old flow:
 *     PENDING_CHEF_APPROVAL  →  AWAITING_PAYMENT (3h window)  →  CONFIRMED
 *
 *   New flow:
 *     PENDING_CHEF_APPROVAL  →  CONFIRMED (no payment window)
 *                                          ↓
 *                              payment any time before session-end OTP
 *                                          ↓
 *                              IN_PROGRESS  →  COMPLETED (gate: payment must be captured)
 *
 * Three properties must hold:
 *
 *   1. `acceptBooking` flips status straight to CONFIRMED, never to
 *      AWAITING_PAYMENT, and clears any stale payment_expires_at.
 *
 *   2. `verifyEndOtp` REFUSES to mark a booking COMPLETED if no
 *      CAPTURED payment row exists. This is the bookend that enforces
 *      "payment optional until session ends" — the chef can request
 *      the end-OTP, but the session won't close until the customer
 *      pays. Without this gate, a chef could finish a session and
 *      walk away unpaid.
 *
 *   3. `verifyEndOtp` succeeds and flips to COMPLETED when a CAPTURED
 *      payment exists. Happy path.
 *
 * No DB. Uses the same minimal-stubs pattern as the other unit specs
 * in this repo (auth.service.change-password.spec.ts,
 * bookings.service.promo.spec.ts).
 */
import { BookingsService } from './bookings.service';
import { Booking, BookingStatus } from './booking.entity';
import { Cook } from '../cooks/cook.entity';
import { Payment, PaymentStatus } from '../payments/payment.entity';
import { BadRequestException } from '@nestjs/common';

interface FakeBooking
  extends Pick<
    Booking,
    | 'id'
    | 'user_id'
    | 'cook_id'
    | 'status'
    | 'created_at'
    | 'chef_responded_at'
    | 'confirmed_at'
    | 'started_at'
    | 'payment_expires_at'
    | 'end_otp'
    | 'end_otp_expires_at'
  > {
  user?: { id: string; email: string | null };
  cook?: { id: string; user_id: string; user?: { name: string } };
}

interface FakeCook extends Pick<Cook, 'id' | 'user_id' | 'total_bookings'> {}

const COOK_USER_ID = '22222222-2222-2222-2222-222222222222';
const COOK_ROW_ID = 'cook-row-id';
const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const BOOKING_ID = '33333333-3333-3333-3333-333333333333';

function makeService(opts: {
  bookingStatus: BookingStatus;
  bookingExtras?: Partial<FakeBooking>;
  payment?: { status: PaymentStatus } | null;
}): {
  service: BookingsService;
  bookingRow: FakeBooking;
  cookRow: FakeCook;
  saved: { booking?: FakeBooking; cook?: FakeCook };
  notify: { chefAccepted: jest.Mock };
} {
  const bookingRow: FakeBooking = {
    id: BOOKING_ID,
    user_id: CUSTOMER_ID,
    cook_id: COOK_ROW_ID,
    status: opts.bookingStatus,
    created_at: new Date(),
    chef_responded_at: null,
    confirmed_at: null,
    started_at: new Date(Date.now() - 30 * 60 * 1000),
    payment_expires_at: null,
    end_otp: '123456',
    end_otp_expires_at: new Date(Date.now() + 5 * 60 * 1000),
    user: { id: CUSTOMER_ID, email: 'rider@example.com' },
    cook: { id: COOK_ROW_ID, user_id: COOK_USER_ID, user: { name: 'Chef X' } },
    ...(opts.bookingExtras ?? {}),
  } as FakeBooking;

  const cookRow: FakeCook = {
    id: COOK_ROW_ID,
    user_id: COOK_USER_ID,
    total_bookings: 0,
  };

  // The save calls in the service are method-keyed (manager.save(Booking, b))
  // and direct (this.bookingsRepository.save(b)). The fake here covers both
  // paths.
  const saved: { booking?: FakeBooking; cook?: FakeCook } = {};

  const bookingsRepo: any = {
    findOne: jest.fn(async (q: any) => {
      // findById path — looks up by booking.id
      if (q?.where?.id === BOOKING_ID) return bookingRow;
      return null;
    }),
    save: jest.fn(async (b: FakeBooking) => {
      Object.assign(bookingRow, b);
      saved.booking = { ...bookingRow };
      return bookingRow;
    }),
    find: jest.fn(async () => []),
  };

  const cooksRepo: any = {
    findOne: jest.fn(async (q: any) => {
      // acceptBooking + verifyEndOtp both look up the chef by user_id
      if (q?.where?.user_id === COOK_USER_ID) return cookRow;
      return null;
    }),
  };

  const paymentsRepo: any = {
    findOne: jest.fn(async () => opts.payment ?? null),
  };

  const notify = {
    chefAccepted: jest.fn().mockResolvedValue(undefined),
  };
  // Every booking-stage notify* helper is fire-and-forget at the call
  // site (chained with .catch). Make sure each one returns a real
  // resolved promise so the .catch lookup doesn't blow up — that's how
  // bookings.service expects them to behave.
  const notifications: any = {
    notifyChefAccepted: notify.chefAccepted,
    notifySessionCompleted: jest.fn().mockResolvedValue(undefined),
    notifyChefSessionCompleted: jest.fn().mockResolvedValue(undefined),
    notifyBookingExpired: jest.fn().mockResolvedValue(undefined),
    notifyReviewPrompt: jest.fn().mockResolvedValue(undefined),
  };

  // dataSource.transaction is used by verifyEndOtp. Provide a fake
  // manager.save that mutates the same in-memory rows so we can assert
  // the final state.
  const dataSource: any = {
    transaction: jest.fn(async (cb: (m: any) => Promise<unknown>) => {
      const manager: any = {
        save: jest.fn(async (entity: any, row: any) => {
          if (entity === Booking) {
            Object.assign(bookingRow, row);
            saved.booking = { ...bookingRow };
          }
          if (entity === Cook) {
            Object.assign(cookRow, row);
            saved.cook = { ...cookRow };
          }
          return row;
        }),
      };
      return cb(manager);
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noop = null as any;
  const service = new BookingsService(
    bookingsRepo, // bookings
    cooksRepo, // cooks
    noop, // users
    noop, // menu items
    paymentsRepo, // payments
    noop, // meal packages
    noop, // package addons
    notifications, // notifications
    { get: () => '' } as any, // configService
    noop, // availabilityService
    noop, // promoCodesService
    dataSource, // dataSource
  );

  return { service, bookingRow, cookRow, saved, notify };
}

describe('BookingsService — booking flow (May 29, 2026 cutover)', () => {
  // ─── 1. acceptBooking → CONFIRMED ─────────────────────────
  describe('acceptBooking', () => {
    it('flips status straight to CONFIRMED (no AWAITING_PAYMENT step) and clears payment_expires_at', async () => {
      const { service, bookingRow, notify } = makeService({
        bookingStatus: BookingStatus.PENDING_CHEF_APPROVAL,
        // Simulate a stale payment_expires_at from a legacy row that
        // somehow had one — accept must wipe it.
        bookingExtras: { payment_expires_at: new Date(Date.now() + 60_000) },
      });

      await service.acceptBooking(BOOKING_ID, COOK_USER_ID);

      expect(bookingRow.status).toBe(BookingStatus.CONFIRMED);
      expect(bookingRow.confirmed_at).toBeInstanceOf(Date);
      expect(bookingRow.chef_responded_at).toBeInstanceOf(Date);
      // The previous flow set payment_expires_at to now + 3h here.
      // The new flow must clear any stale value.
      expect(bookingRow.payment_expires_at).toBeNull();
      // Notification still fires — the message itself was rewritten in
      // notifications.service.ts to drop the "pay within 3 hours" copy,
      // tested separately.
      expect(notify.chefAccepted).toHaveBeenCalledTimes(1);
    });

    it('refuses to accept a booking whose status is not PENDING_CHEF_APPROVAL or PENDING (legacy)', async () => {
      const { service } = makeService({
        bookingStatus: BookingStatus.CONFIRMED, // already accepted
      });

      await expect(
        service.acceptBooking(BOOKING_ID, COOK_USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.acceptBooking(BOOKING_ID, COOK_USER_ID),
      ).rejects.toThrow(/cannot accept/i);
    });
  });

  // ─── 2. verifyEndOtp payment-required gate ────────────────
  describe('verifyEndOtp — payment-required gate', () => {
    it('REJECTS when no payment row exists at all', async () => {
      const { service, bookingRow } = makeService({
        bookingStatus: BookingStatus.IN_PROGRESS,
        payment: null,
      });

      await expect(
        service.verifyEndOtp(BOOKING_ID, COOK_USER_ID, '123456'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.verifyEndOtp(BOOKING_ID, COOK_USER_ID, '123456'),
      ).rejects.toThrow(/payment must be completed/i);

      // Status must stay IN_PROGRESS — chef can request a fresh end-OTP
      // and try again once the customer pays.
      expect(bookingRow.status).toBe(BookingStatus.IN_PROGRESS);
    });

    it('REJECTS when payment exists but is not CAPTURED (e.g. CREATED, FAILED)', async () => {
      const { service, bookingRow } = makeService({
        bookingStatus: BookingStatus.IN_PROGRESS,
        payment: { status: PaymentStatus.CREATED },
      });

      await expect(
        service.verifyEndOtp(BOOKING_ID, COOK_USER_ID, '123456'),
      ).rejects.toThrow(/payment must be completed/i);
      expect(bookingRow.status).toBe(BookingStatus.IN_PROGRESS);
    });

    it('SUCCEEDS when a CAPTURED payment row exists — flips to COMPLETED', async () => {
      const { service, bookingRow } = makeService({
        bookingStatus: BookingStatus.IN_PROGRESS,
        payment: { status: PaymentStatus.CAPTURED },
      });

      await service.verifyEndOtp(BOOKING_ID, COOK_USER_ID, '123456');

      expect(bookingRow.status).toBe(BookingStatus.COMPLETED);
      expect(bookingRow.end_otp).toBeNull();
      expect(bookingRow.end_otp_expires_at).toBeNull();
    });

    it('still rejects on an invalid OTP even when payment is captured (auth check fires first)', async () => {
      const { service, bookingRow } = makeService({
        bookingStatus: BookingStatus.IN_PROGRESS,
        payment: { status: PaymentStatus.CAPTURED },
      });

      await expect(
        service.verifyEndOtp(BOOKING_ID, COOK_USER_ID, '999999'),
      ).rejects.toThrow(/invalid otp/i);
      expect(bookingRow.status).toBe(BookingStatus.IN_PROGRESS);
    });
  });
});
