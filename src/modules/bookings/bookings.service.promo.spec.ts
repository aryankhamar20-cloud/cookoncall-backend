/**
 * BookingsService.resolvePromoForBooking — unit spec
 *
 * Locks in the gateway between BookingsService.createBooking and
 * PromoCodesService.validate. Three properties:
 *
 *   1. No promo_code in the DTO → returns null, never touches PromoCodesService.
 *   2. promo_code present → calls validate with the correct shape
 *      (uppercase trimmed code, gross order_amount) and returns the
 *      { promoId, promoSnapshot, discount } the booking flow consumes.
 *   3. PromoCodesService.validate throws (bad code, expired, exhausted,
 *      single-use already used, min-order not met) → exception propagates
 *      unchanged. Booking creation must abort, NOT silently fall back to
 *      no-discount.
 *
 * Why these three properties matter
 * ---------------------------------
 * Booking creation is the only place a discount actually moves money —
 * the validate-only POST /promo-codes/validate is preview UX. If the
 * gateway here ever silently swallows a validate failure, an attacker
 * can post any code they want and get the request through with promo
 * fields nulled out. Worse: a code that just expired between the
 * customer's "Apply" click and "Book" click would silently book at
 * full price instead of telling them.
 *
 * The helper is private — accessed via `as any` for the test, which
 * is acceptable here because the helper has no public surface. The
 * integration end-to-end (full createBooking with promo applied to
 * the saved row) is a follow-up TODO documented in the PR description.
 */
import { BookingsService } from './bookings.service';
import { PromoCodesService } from '../promo-codes/promo-codes.service';
import { PromoType } from '../promo-codes/promo-code.entity';
import { BadRequestException } from '@nestjs/common';

interface PromoResult {
  promoId: string;
  promoSnapshot: string;
  discount: number;
}

/** Cast the bag of mocks to `any` so we can poke at private methods. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAccess = any;

function makeService(): {
  service: BookingsService;
  callHelper: (
    userId: string,
    code: string | undefined,
    grossTotal: number,
  ) => Promise<PromoResult | null>;
  promoCodesService: { validate: jest.Mock };
} {
  const promoCodesService = { validate: jest.fn() };

  // BookingsService has many constructor deps. Most are unused by the
  // helper under test; pass `null as any` for those and only the promo
  // service (and the configService that the constructor body reads on
  // boot) are real.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noop = null as any;
  const service = new BookingsService(
    noop, // bookingsRepository
    noop, // cooksRepository
    noop, // usersRepository
    noop, // menuItemsRepository
    noop, // paymentsRepository
    noop, // mealPackagesRepository
    noop, // packageAddonsRepository
    noop, // notificationsService
    { get: () => '' } as AnyAccess, // configService — constructor reads BREVO_API_KEY
    noop, // availabilityService
    promoCodesService as AnyAccess as PromoCodesService,
    noop, // dataSource
  );

  const callHelper = (
    userId: string,
    code: string | undefined,
    grossTotal: number,
  ): Promise<PromoResult | null> =>
    (service as AnyAccess).resolvePromoForBooking(userId, code, grossTotal);

  return { service, callHelper, promoCodesService };
}

const USER_ID = '11111111-1111-1111-1111-111111111111';
const PROMO_ROW_ID = 'promo-uuid-aaaa';

describe('BookingsService.resolvePromoForBooking', () => {
  it('returns null when no promo_code is supplied (helper does not touch PromoCodesService)', async () => {
    const { callHelper, promoCodesService } = makeService();
    const result = await callHelper(USER_ID, undefined, 1000);
    expect(result).toBeNull();
    expect(promoCodesService.validate).not.toHaveBeenCalled();
  });

  it('returns null when promo_code is the empty string or whitespace (treated as absent)', async () => {
    const { callHelper, promoCodesService } = makeService();
    expect(await callHelper(USER_ID, '', 1000)).toBeNull();
    expect(await callHelper(USER_ID, '   ', 1000)).toBeNull();
    expect(promoCodesService.validate).not.toHaveBeenCalled();
  });

  it('forwards the trimmed code + gross total to validate and returns the discount shape', async () => {
    const { callHelper, promoCodesService } = makeService();
    promoCodesService.validate.mockResolvedValueOnce({
      valid: true,
      discount: 100,
      final_amount: 900,
      promo: {
        id: PROMO_ROW_ID,
        code: 'WELCOME20',
        type: PromoType.FLAT,
        value: 100,
        description: '₹100 off your first booking',
      },
      message: 'Promo applied! You save ₹100',
    });

    const result = await callHelper(
      USER_ID,
      '  WELCOME20  ', // exercises the trim()
      1000,
    );

    expect(promoCodesService.validate).toHaveBeenCalledTimes(1);
    expect(promoCodesService.validate).toHaveBeenCalledWith(USER_ID, {
      code: 'WELCOME20', // trimmed
      order_amount: 1000, // gross, not post-discount
    });
    expect(result).toEqual({
      promoId: PROMO_ROW_ID,
      promoSnapshot: 'WELCOME20',
      discount: 100,
    });
  });

  it('propagates BadRequestException from validate (does NOT silently null out the promo)', async () => {
    const { callHelper, promoCodesService } = makeService();
    promoCodesService.validate.mockRejectedValue(
      new BadRequestException('This promo code has expired'),
    );

    await expect(
      callHelper(USER_ID, 'EXPIRED50', 1000),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      callHelper(USER_ID, 'EXPIRED50', 1000),
    ).rejects.toThrow(/expired/i);
  });

  it('propagates "single-use already used" rejection unchanged', async () => {
    const { callHelper, promoCodesService } = makeService();
    promoCodesService.validate.mockRejectedValueOnce(
      new BadRequestException('You have already used this promo code'),
    );

    await expect(
      callHelper(USER_ID, 'WELCOME20', 1000),
    ).rejects.toThrow(/already used/i);
  });

  it('propagates min-order-amount rejection unchanged (so the customer sees the threshold)', async () => {
    const { callHelper, promoCodesService } = makeService();
    promoCodesService.validate.mockRejectedValueOnce(
      new BadRequestException(
        'Minimum order amount of ₹500 required for this promo',
      ),
    );

    await expect(
      callHelper(USER_ID, 'BIGORDER', 200),
    ).rejects.toThrow(/minimum order amount of ₹500/i);
  });
});
