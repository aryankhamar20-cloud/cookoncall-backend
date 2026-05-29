/**
 * BookingsController — defense-in-depth spec
 *
 * Locks in the security fix from PR #20:
 *   - GET /bookings/:id throws 403 (not 200 with a benign message)
 *     when the caller is not the customer / cook / admin.
 *   - GET /bookings/:id/refund-estimate requires the same authz —
 *     previously it had no @CurrentUser at all and any authenticated
 *     user could pull total_price + policy text for any booking by
 *     UUID.
 *
 * Same e2e harness as PromoCodesController spec: full NestApplication
 * + supertest, with JwtAuthGuard overridden to inject a synthetic
 * user, and BookingsService / ReceiptService stubbed so we never
 * touch a database or Razorpay.
 *
 * Adding a new route to BookingsController that returns booking
 * data without an ownership / role check will not be caught by this
 * spec automatically — but the cases here document the canonical
 * ownership rule (customer | cook | admin) so a reviewer can copy
 * the pattern when adding new routes.
 */
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { ReceiptService } from './receipt.service';
import { UserRole } from '../users/user.entity';
import { BookingStatus } from './booking.entity';

const STUB_BOOKING_ID = '33333333-3333-3333-3333-333333333333';
const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const COOK_USER_ID = '22222222-2222-2222-2222-222222222222';
const STRANGER_ID = '99999999-9999-9999-9999-999999999999';
const ADMIN_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Minimal Booking shape that satisfies the controller's read-side
 * checks. Adding more fields here is fine; the goal is to mirror the
 * shape findById() actually returns just enough that controller
 * decisions go down the right branch.
 */
function makeBooking() {
  return {
    id: STUB_BOOKING_ID,
    user_id: CUSTOMER_ID,
    cook_id: 'cook-row-id',
    cook: {
      id: 'cook-row-id',
      user_id: COOK_USER_ID,
      user: { name: 'Chef Test' },
    },
    status: BookingStatus.CONFIRMED,
    scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    total_price: 500,
    subtotal: 400,
    visit_fee: 49,
    platform_fee: 51,
  };
}

describe('BookingsController defense-in-depth (PR #20)', () => {
  let app: INestApplication;

  type Caller = { id: string; role: UserRole } | null;
  let currentCaller: Caller = { id: CUSTOMER_ID, role: UserRole.USER };

  const bookingsServiceMock = {
    findById: jest.fn(async () => makeBooking()),
    findByIdForCustomer: jest.fn(async () => ({
      ...makeBooking(),
      // Customer-view strips internal fields. Doesn't affect the
      // assertions here, just mirrors the real method's contract.
    })),
    getCancellationRefund: jest.fn(() => ({
      refund: 250,
      chefCompensation: 50,
    })),
  };

  const receiptServiceMock = {
    // Receipt isn't exercised by this spec but the controller depends
    // on the provider being injectable.
    generate: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BookingsController],
      providers: [
        { provide: BookingsService, useValue: bookingsServiceMock },
        { provide: ReceiptService, useValue: receiptServiceMock },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    // BookingsController has no controller-level @UseGuards — in
    // production it relies on the GLOBAL JwtAuthGuard wired via
    // APP_GUARD in auth.module.ts. The test bootstraps just this
    // controller, so we need to install our fake guard globally for
    // the test app to mimic production. Otherwise @CurrentUser()
    // gets undefined and every test fails with a 500.
    app.useGlobalGuards({
      canActivate: (ctx: ExecutionContext) => {
        if (currentCaller === null) return false;
        const req = ctx.switchToHttp().getRequest();
        req.user = currentCaller;
        return true;
      },
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── GET /bookings/:id ────────────────────────────────────
  describe('GET /bookings/:id', () => {
    it('lets the booking owner (customer) through with 2xx', async () => {
      currentCaller = { id: CUSTOMER_ID, role: UserRole.USER };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}`,
      );
      expect(res.status).toBeLessThan(400);
      // Customer view should call findByIdForCustomer, not the raw findById.
      expect(bookingsServiceMock.findByIdForCustomer).toHaveBeenCalledWith(
        STUB_BOOKING_ID,
      );
    });

    it('lets the assigned cook through with 2xx (raw findById view)', async () => {
      currentCaller = { id: COOK_USER_ID, role: UserRole.COOK };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}`,
      );
      expect(res.status).toBeLessThan(400);
      // Cook gets the raw view — no findByIdForCustomer call.
      expect(bookingsServiceMock.findByIdForCustomer).not.toHaveBeenCalled();
    });

    it('lets an admin through with 2xx', async () => {
      currentCaller = { id: ADMIN_ID, role: UserRole.ADMIN };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}`,
      );
      expect(res.status).toBeLessThan(400);
    });

    it('throws 403 for a stranger (regression: previously returned 200 with benign message)', async () => {
      currentCaller = { id: STRANGER_ID, role: UserRole.USER };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}`,
      );
      expect(res.status).toBe(403);
      // Body should NOT be the old { message: 'Not authorized to view this booking' }
      // shape — that was a 200, this is a Nest ForbiddenException JSON.
      expect(res.body).toMatchObject({ statusCode: 403 });
      // Service ownership-aware methods should NOT have been called for
      // the stranger (the controller short-circuits after the authz check).
      expect(bookingsServiceMock.findByIdForCustomer).not.toHaveBeenCalled();
    });

    it('throws 403 for a cook who is NOT the assigned cook on this booking', async () => {
      // A different cook trying to peek at someone else's booking.
      currentCaller = { id: STRANGER_ID, role: UserRole.COOK };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}`,
      );
      expect(res.status).toBe(403);
    });
  });

  // ─── GET /bookings/:id/refund-estimate ────────────────────
  describe('GET /bookings/:id/refund-estimate', () => {
    it('lets the booking owner (customer) through with 2xx', async () => {
      currentCaller = { id: CUSTOMER_ID, role: UserRole.USER };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}/refund-estimate`,
      );
      expect(res.status).toBeLessThan(400);
      // Sanity: refund-estimate runs the cancellation calc.
      expect(bookingsServiceMock.getCancellationRefund).toHaveBeenCalledTimes(1);
    });

    it('lets the assigned cook through with 2xx', async () => {
      currentCaller = { id: COOK_USER_ID, role: UserRole.COOK };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}/refund-estimate`,
      );
      expect(res.status).toBeLessThan(400);
    });

    it('lets an admin through with 2xx', async () => {
      currentCaller = { id: ADMIN_ID, role: UserRole.ADMIN };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}/refund-estimate`,
      );
      expect(res.status).toBeLessThan(400);
    });

    it('throws 403 for a stranger (regression: previously had NO authz check at all)', async () => {
      currentCaller = { id: STRANGER_ID, role: UserRole.USER };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}/refund-estimate`,
      );
      expect(res.status).toBe(403);
      // Confirm the cancellation calculator was NOT invoked — the
      // controller short-circuits before computing anything that
      // would leak total_price / policy text.
      expect(bookingsServiceMock.getCancellationRefund).not.toHaveBeenCalled();
    });

    it('throws 403 for a cook who is NOT the assigned cook', async () => {
      currentCaller = { id: STRANGER_ID, role: UserRole.COOK };
      const res = await request(app.getHttpServer()).get(
        `/bookings/${STUB_BOOKING_ID}/refund-estimate`,
      );
      expect(res.status).toBe(403);
      expect(bookingsServiceMock.getCancellationRefund).not.toHaveBeenCalled();
    });
  });
});
