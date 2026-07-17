/**
 * SubscriptionsService.computeNextRunAt — unit spec.
 *
 * The generation cron lives or dies by this date maths. It must:
 *   1. Pick the next matching weekday at the given time IN IST, and store
 *      the correct UTC instant (IST = UTC+5:30).
 *   2. Honour cadence week-alignment (weekly every week, biweekly every
 *      other week) relative to the subscription's start.
 *   3. Return null when no day-of-week is selected.
 *
 * computeNextRunAt is private; accessed via `as any` (no public surface).
 */
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionCadence } from './subscription.entity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRepo = any;

function makeService() {
  const subRepo = {};
  const runRepo = {};
  const cookRepo = {};
  const bookingsService = { createBooking: jest.fn() };
  const service = new SubscriptionsService(
    subRepo as AnyRepo,
    runRepo as AnyRepo,
    cookRepo as AnyRepo,
    bookingsService as AnyRepo,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compute = (service as any).computeNextRunAt.bind(service);
  return { service, compute };
}

describe('SubscriptionsService.computeNextRunAt (IST)', () => {
  // 2026-01-04 is a Sunday (UTC). Start the plan then.
  const start = new Date('2026-01-04T00:00:00Z');

  it('returns null when no days are selected', () => {
    const { compute } = makeService();
    expect(compute(start, [], '20:00', SubscriptionCadence.WEEKLY, start)).toBeNull();
  });

  it('picks the next Monday 20:00 IST and stores it as 14:30 UTC', () => {
    const { compute } = makeService();
    // Monday = JS getDay() 1. Next Monday after Sun Jan 4 is Jan 5.
    const next: Date = compute(start, [1], '20:00', SubscriptionCadence.WEEKLY, start);
    // 20:00 IST == 14:30 UTC
    expect(next.toISOString()).toBe('2026-01-05T14:30:00.000Z');
  });

  it('weekly repeats every week', () => {
    const { compute } = makeService();
    const first: Date = compute(start, [1], '20:00', SubscriptionCadence.WEEKLY, start);
    const second: Date = compute(first, [1], '20:00', SubscriptionCadence.WEEKLY, start);
    // Exactly 7 days later.
    expect(second.getTime() - first.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('biweekly skips a week', () => {
    const { compute } = makeService();
    const first: Date = compute(start, [1], '20:00', SubscriptionCadence.BIWEEKLY, start);
    const second: Date = compute(first, [1], '20:00', SubscriptionCadence.BIWEEKLY, start);
    // 14 days later, not 7.
    expect(second.getTime() - first.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  });
});
