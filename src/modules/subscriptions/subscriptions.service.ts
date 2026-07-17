import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Subscription, SubscriptionStatus, SubscriptionCadence } from './subscription.entity';
import { SubscriptionRun, SubscriptionRunStatus } from './subscription-run.entity';
import { Cook } from '../cooks/cook.entity';
import { BookingsService } from '../bookings/bookings.service';

/** How many days ahead the cron materializes upcoming sessions. */
const LEAD_DAYS = 2;
const WEEKS_STEP: Record<SubscriptionCadence, number> = {
  [SubscriptionCadence.WEEKLY]: 1,
  [SubscriptionCadence.BIWEEKLY]: 2,
  [SubscriptionCadence.MONTHLY]: 4,
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subRepo: Repository<Subscription>,
    @InjectRepository(SubscriptionRun)
    private readonly runRepo: Repository<SubscriptionRun>,
    @InjectRepository(Cook)
    private readonly cookRepo: Repository<Cook>,
    private readonly bookingsService: BookingsService,
  ) {}

  // ─── Date helpers ────────────────────────────────────────────
  // Sessions are scheduled in IST (the market we serve). Railway runs the
  // process in UTC, so we do all wall-clock maths in an "IST view" (shift
  // by +5:30 and use UTC getters/setters), then subtract the offset to get
  // the true UTC instant we persist.
  private static readonly IST_OFFSET_MS = 330 * 60 * 1000;

  private startOfWeekUtc(d: Date): number {
    const c = new Date(d);
    c.setUTCHours(0, 0, 0, 0);
    c.setUTCDate(c.getUTCDate() - c.getUTCDay()); // back to Sunday
    return c.getTime();
  }

  /**
   * Next datetime strictly after `after` that matches one of `days` at
   * `time_slot` (interpreted in IST), honouring the cadence's week alignment
   * relative to `started`. Returns null if nothing matches within 70 days.
   */
  private computeNextRunAt(
    after: Date,
    days: number[],
    timeSlot: string,
    cadence: SubscriptionCadence,
    started: Date,
  ): Date | null {
    if (!days || days.length === 0) return null;
    const [hh, mm] = timeSlot.split(':').map((n) => parseInt(n, 10));
    const step = WEEKS_STEP[cadence] ?? 1;
    const OFF = SubscriptionsService.IST_OFFSET_MS;

    // Shift into the IST "view" so UTC getters/setters read IST wall-clock.
    const afterIst = new Date(after.getTime() + OFF);
    const startWeekIst = this.startOfWeekUtc(new Date((started ?? new Date()).getTime() + OFF));

    for (let i = 0; i <= 70; i++) {
      const dIst = new Date(afterIst);
      dIst.setUTCDate(dIst.getUTCDate() + i);
      dIst.setUTCHours(hh || 0, mm || 0, 0, 0);
      if (dIst <= afterIst) continue;
      if (!days.includes(dIst.getUTCDay())) continue;
      const weeks = Math.round((this.startOfWeekUtc(dIst) - startWeekIst) / (7 * 86400000));
      if (weeks % step !== 0) continue;
      // Back to the real UTC instant for storage.
      return new Date(dIst.getTime() - OFF);
    }
    return null;
  }

  // ─── CRUD ────────────────────────────────────────────────────
  async create(
    userId: string,
    dto: {
      cook_id: string;
      cadence: SubscriptionCadence;
      days_of_week: number[];
      time_slot: string;
      meal_package_id?: string;
      address_id?: string;
      price_per_session?: number;
      booking_template: Record<string, unknown>;
      ends_at?: string;
    },
  ): Promise<Subscription> {
    const cook = await this.cookRepo.findOne({ where: { id: dto.cook_id } });
    if (!cook) throw new NotFoundException('Chef not found');
    if (!dto.days_of_week?.length) {
      throw new BadRequestException('Pick at least one day of the week');
    }
    if (!dto.booking_template || !dto.booking_template['cook_id']) {
      throw new BadRequestException('A booking template (chef + dishes + address) is required');
    }

    const now = new Date();
    const started = now;
    const nextRun = this.computeNextRunAt(now, dto.days_of_week, dto.time_slot, dto.cadence, started);

    const sub = this.subRepo.create({
      user_id: userId,
      cook_id: dto.cook_id,
      meal_package_id: dto.meal_package_id ?? null,
      cadence: dto.cadence,
      days_of_week: dto.days_of_week,
      time_slot: dto.time_slot,
      address_id: dto.address_id ?? null,
      price_per_session: dto.price_per_session ?? 0,
      booking_template: dto.booking_template,
      status: SubscriptionStatus.ACTIVE,
      started_at: started,
      ends_at: dto.ends_at ? new Date(dto.ends_at) : null,
      next_run_at: nextRun,
    });
    return this.subRepo.save(sub);
  }

  private async ownedSub(id: string, userId: string): Promise<Subscription> {
    const sub = await this.subRepo.findOne({ where: { id } });
    if (!sub) throw new NotFoundException('Subscription not found');
    if (sub.user_id !== userId) throw new NotFoundException('Subscription not found');
    return sub;
  }

  async listForUser(userId: string): Promise<Subscription[]> {
    return this.subRepo.find({
      where: { user_id: userId },
      relations: ['cook', 'cook.user'],
      order: { created_at: 'DESC' },
    });
  }

  async listForCookUser(userId: string): Promise<Subscription[]> {
    const cook = await this.cookRepo.findOne({ where: { user_id: userId } });
    if (!cook) throw new NotFoundException('Chef profile not found');
    return this.subRepo.find({
      where: { cook_id: cook.id, status: SubscriptionStatus.ACTIVE },
      relations: ['user'],
      order: { next_run_at: 'ASC' },
    });
  }

  async adminList(page = 1, limit = 20) {
    const [subscriptions, total] = await this.subRepo.findAndCount({
      relations: ['cook', 'cook.user', 'user'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { subscriptions, total };
  }

  async pause(id: string, userId: string): Promise<Subscription> {
    const sub = await this.ownedSub(id, userId);
    sub.status = SubscriptionStatus.PAUSED;
    return this.subRepo.save(sub);
  }

  async resume(id: string, userId: string): Promise<Subscription> {
    const sub = await this.ownedSub(id, userId);
    if (sub.status === SubscriptionStatus.CANCELLED) {
      throw new BadRequestException('A cancelled subscription cannot be resumed');
    }
    sub.status = SubscriptionStatus.ACTIVE;
    // Recompute the next run from now so we don't backfill missed slots.
    sub.next_run_at = this.computeNextRunAt(
      new Date(),
      sub.days_of_week,
      sub.time_slot,
      sub.cadence,
      sub.started_at ?? new Date(),
    );
    return this.subRepo.save(sub);
  }

  async cancel(id: string, userId: string): Promise<Subscription> {
    const sub = await this.ownedSub(id, userId);
    sub.status = SubscriptionStatus.CANCELLED;
    sub.next_run_at = null;
    return this.subRepo.save(sub);
  }

  // ─── Generation cron ─────────────────────────────────────────
  // Runs hourly; materializes any active subscription whose next slot is
  // within LEAD_DAYS into a real booking (idempotent via the unique
  // (subscription_id, scheduled_for) index on runs).
  @Cron(CronExpression.EVERY_HOUR)
  async generateDueSessions(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + LEAD_DAYS);

    const due = await this.subRepo.find({
      where: {
        status: SubscriptionStatus.ACTIVE,
        next_run_at: LessThanOrEqual(cutoff),
      },
    });
    if (due.length === 0) return;
    this.logger.log(`Subscription cron: ${due.length} due`);

    for (const sub of due) {
      const slot = sub.next_run_at;
      if (!slot) continue;
      if (sub.ends_at && slot > sub.ends_at) {
        sub.status = SubscriptionStatus.CANCELLED;
        sub.next_run_at = null;
        await this.subRepo.save(sub);
        continue;
      }

      // Idempotency: skip if we already have a run for this exact slot.
      const existing = await this.runRepo.findOne({
        where: { subscription_id: sub.id, scheduled_for: slot },
      });

      if (!existing) {
        try {
          const dto = {
            ...(sub.booking_template as Record<string, unknown>),
            scheduled_at: slot.toISOString(),
          } as any;
          const booking = await this.bookingsService.createBooking(sub.user_id, dto);
          await this.runRepo.save(
            this.runRepo.create({
              subscription_id: sub.id,
              booking_id: (booking as any)?.id ?? null,
              scheduled_for: slot,
              status: SubscriptionRunStatus.SCHEDULED,
            }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Subscription ${sub.id} slot ${slot.toISOString()} skipped: ${msg}`);
          await this.runRepo.save(
            this.runRepo.create({
              subscription_id: sub.id,
              booking_id: null,
              scheduled_for: slot,
              status: SubscriptionRunStatus.SKIPPED,
            }),
          );
        }
      }

      // Advance to the next slot regardless (so a skipped slot doesn't wedge the plan).
      const next = this.computeNextRunAt(
        slot,
        sub.days_of_week,
        sub.time_slot,
        sub.cadence,
        sub.started_at ?? slot,
      );
      sub.next_run_at = next && sub.ends_at && next > sub.ends_at ? null : next;
      if (!sub.next_run_at && sub.ends_at) sub.status = SubscriptionStatus.CANCELLED;
      await this.subRepo.save(sub);
    }
  }
}
