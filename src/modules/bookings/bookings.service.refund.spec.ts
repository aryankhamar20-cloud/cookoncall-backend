/**
 * BookingsService.getCancellationRefund — Refund Policy v2 (LOCKED) spec.
 *
 * Money-critical: this decides how much a customer gets back and how much
 * the chef is compensated when a booking is cancelled. The tiers are a
 * business-locked contract — this test makes any accidental change loud.
 *
 *   ≥24h : 100% refund / chef ₹0
 *   ≥8h  :  75% refund / chef ₹25
 *   ≥4h  :  50% refund / chef ₹50
 *   ≥2h  :  25% refund / chef ₹75
 *   <2h  :   0% refund / chef ₹100
 *
 * The method reads only `scheduled_at` + `total_price` and uses no `this`,
 * so we invoke it off the prototype without constructing the full service.
 */
import { BookingsService } from './bookings.service';

function refundFor(hoursFromNow: number, total: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = Object.create(BookingsService.prototype) as BookingsService;
  const booking = {
    scheduled_at: new Date(Date.now() + hoursFromNow * 60 * 60 * 1000),
    total_price: total,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return service.getCancellationRefund(booking);
}

describe('getCancellationRefund — LOCKED tiers (total ₹1000)', () => {
  it('≥24h → 100% refund, chef ₹0', () => {
    expect(refundFor(25, 1000)).toEqual({ refund: 1000, chefCompensation: 0 });
  });
  it('≥8h and <24h → 75% refund, chef ₹25', () => {
    expect(refundFor(10, 1000)).toEqual({ refund: 750, chefCompensation: 25 });
  });
  it('≥4h and <8h → 50% refund, chef ₹50', () => {
    expect(refundFor(5, 1000)).toEqual({ refund: 500, chefCompensation: 50 });
  });
  it('≥2h and <4h → 25% refund, chef ₹75', () => {
    expect(refundFor(3, 1000)).toEqual({ refund: 250, chefCompensation: 75 });
  });
  it('<2h → 0% refund, chef ₹100', () => {
    expect(refundFor(1, 1000)).toEqual({ refund: 0, chefCompensation: 100 });
  });
  it('rounds to 2 decimals', () => {
    // 75% of 333.33 = 249.9975 → 250.00
    expect(refundFor(10, 333.33).refund).toBe(250);
  });
});
