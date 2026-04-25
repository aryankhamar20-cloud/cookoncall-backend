import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Not, Repository } from 'typeorm';
import {
  AvailabilitySchedule,
  AvailabilityOverride,
} from './availability.entity';
import { Cook } from '../cooks/cook.entity';
import { Booking, BookingStatus } from '../bookings/booking.entity';
import {
  UpsertScheduleDto,
  UpsertOverrideDto,
  UpdateAvailabilitySettingsDto,
  TimeWindowDto,
} from './dto/availability.dto';

// IST = UTC+5:30. All chefs in Ahmedabad — no per-chef timezone needed.
const IST_OFFSET_MIN = 5 * 60 + 30;

// Statuses that block a slot (chef is committed)
const BLOCKING_STATUSES: BookingStatus[] = [
  BookingStatus.AWAITING_PAYMENT,
  BookingStatus.CONFIRMED,
  BookingStatus.IN_PROGRESS,
  BookingStatus.PENDING_CHEF_APPROVAL,
  BookingStatus.PENDING, // legacy
];

interface Slot {
  start: string; // ISO UTC
  end: string;
  label: string; // e.g. "06:00 PM"
}

@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(AvailabilitySchedule)
    private schedulesRepo: Repository<AvailabilitySchedule>,
    @InjectRepository(AvailabilityOverride)
    private overridesRepo: Repository<AvailabilityOverride>,
    @InjectRepository(Cook)
    private cooksRepo: Repository<Cook>,
    @InjectRepository(Booking)
    private bookingsRepo: Repository<Booking>,
  ) {}

  // ─── CHEF: read full availability ─────────────────────
  async getMyAvailability(userId: string) {
    const cook = await this.cooksRepo.findOne({ where: { user_id: userId } });
    if (!cook) throw new NotFoundException('Cook profile not found');
    return this.getCookAvailability(cook.id);
  }

  async getCookAvailability(cookId: string) {
    const cook = await this.cooksRepo.findOne({ where: { id: cookId } });
    if (!cook) throw new NotFoundException('Cook not found');

    const schedules = await this.schedulesRepo.find({
      where: { cook_id: cookId },
      order: { weekday: 'ASC' },
    });

    // Overrides for next 90 days only (UI scope)
    const today = this.todayIstYmd();
    const future = this.addDays(today, 90);
    const overrides = await this.overridesRepo.find({
      where: { cook_id: cookId, date: Between(today, future) },
      order: { date: 'ASC' },
    });

    return {
      schedules,
      overrides,
      settings: {
        min_advance_notice_minutes: cook.min_advance_notice_minutes,
        booking_buffer_minutes: cook.booking_buffer_minutes,
      },
    };
  }

  // ─── CHEF: upsert weekly schedule for one weekday ─────
  async upsertSchedule(userId: string, dto: UpsertScheduleDto) {
    const cook = await this.cooksRepo.findOne({ where: { user_id: userId } });
    if (!cook) throw new NotFoundException('Cook profile not found');

    this.validateWindows(dto.windows, dto.enabled);

    const existing = await this.schedulesRepo.findOne({
      where: { cook_id: cook.id, weekday: dto.weekday },
    });

    if (existing) {
      existing.enabled = dto.enabled;
      existing.windows = dto.enabled ? dto.windows : [];
      return this.schedulesRepo.save(existing);
    }

    const created = this.schedulesRepo.create({
      cook_id: cook.id,
      weekday: dto.weekday,
      enabled: dto.enabled,
      windows: dto.enabled ? dto.windows : [],
    });
    return this.schedulesRepo.save(created);
  }

  // ─── CHEF: upsert date override ───────────────────────
  async upsertOverride(userId: string, dto: UpsertOverrideDto) {
    const cook = await this.cooksRepo.findOne({ where: { user_id: userId } });
    if (!cook) throw new NotFoundException('Cook profile not found');

    if (dto.date < this.todayIstYmd()) {
      throw new BadRequestException('Cannot set override for past dates');
    }
    this.validateWindows(dto.windows, !dto.closed);

    const existing = await this.overridesRepo.findOne({
      where: { cook_id: cook.id, date: dto.date },
    });
    if (existing) {
      existing.closed = dto.closed;
      existing.windows = dto.closed ? [] : dto.windows;
      existing.note = dto.note ?? null;
      return this.overridesRepo.save(existing);
    }
    const created = this.overridesRepo.create({
      cook_id: cook.id,
      date: dto.date,
      closed: dto.closed,
      windows: dto.closed ? [] : dto.windows,
      note: dto.note ?? null,
    });
    return this.overridesRepo.save(created);
  }

  async deleteOverride(userId: string, overrideId: string) {
    const cook = await this.cooksRepo.findOne({ where: { user_id: userId } });
    if (!cook) throw new NotFoundException('Cook profile not found');
    const ovr = await this.overridesRepo.findOne({
      where: { id: overrideId, cook_id: cook.id },
    });
    if (!ovr) throw new NotFoundException('Override not found');
    await this.overridesRepo.remove(ovr);
    return { success: true };
  }

  // ─── CHEF: update settings (min advance / buffer) ─────
  async updateSettings(userId: string, dto: UpdateAvailabilitySettingsDto) {
    const cook = await this.cooksRepo.findOne({ where: { user_id: userId } });
    if (!cook) throw new NotFoundException('Cook profile not found');
    if (dto.min_advance_notice_minutes !== undefined) {
      cook.min_advance_notice_minutes = dto.min_advance_notice_minutes;
    }
    if (dto.booking_buffer_minutes !== undefined) {
      cook.booking_buffer_minutes = dto.booking_buffer_minutes;
    }
    await this.cooksRepo.save(cook);
    return {
      min_advance_notice_minutes: cook.min_advance_notice_minutes,
      booking_buffer_minutes: cook.booking_buffer_minutes,
    };
  }

  // ─── PUBLIC: get available slots for a chef on a date ─
  // Returns 30-min slot starts where a booking of `durationHours`
  // would fully fit inside an open window, doesn't collide with
  // existing bookings (+buffer), and respects min advance notice.
  async getAvailableSlots(
    cookId: string,
    dateYmd: string,
    durationHours: number,
  ): Promise<Slot[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    const dur = Math.max(1, Math.min(8, Math.round(durationHours || 2)));
    const cook = await this.cooksRepo.findOne({ where: { id: cookId } });
    if (!cook) throw new NotFoundException('Cook not found');

    // 1. Pick effective windows for that date: override beats schedule.
    const override = await this.overridesRepo.findOne({
      where: { cook_id: cookId, date: dateYmd },
    });
    let windows: { start: string; end: string }[] = [];
    if (override) {
      if (override.closed) return [];
      windows = override.windows || [];
    } else {
      const weekday = this.weekdayIst(dateYmd);
      const sched = await this.schedulesRepo.findOne({
        where: { cook_id: cookId, weekday },
      });
      if (!sched || !sched.enabled) return [];
      windows = sched.windows || [];
    }
    if (windows.length === 0) return [];

    // 2. Get this chef's existing blocking bookings for the day
    //    (look at IST day boundary expressed in UTC).
    const dayStartUtc = this.istYmdHmToUtc(dateYmd, '00:00');
    const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);
    const existing = await this.bookingsRepo.find({
      where: {
        cook_id: cookId,
        status: In(BLOCKING_STATUSES),
        scheduled_at: Between(dayStartUtc, dayEndUtc),
      },
    });

    const buffer = (cook.booking_buffer_minutes || 30) * 60 * 1000;
    const minAdvanceMs = (cook.min_advance_notice_minutes || 60) * 60 * 1000;
    const earliest = new Date(Date.now() + minAdvanceMs);

    // 3. Walk every 30-min start within each window, keep slots that fit.
    const out: Slot[] = [];
    const STEP_MS = 30 * 60 * 1000;
    const durMs = dur * 60 * 60 * 1000;

    for (const w of windows) {
      const wStart = this.istYmdHmToUtc(dateYmd, w.start);
      const wEnd = this.istYmdHmToUtc(dateYmd, w.end);
      // Last possible slot start = window end - duration.
      for (let t = wStart.getTime(); t + durMs <= wEnd.getTime(); t += STEP_MS) {
        const slotStart = t;
        const slotEnd = t + durMs;

        if (slotStart < earliest.getTime()) continue;

        // Collision with existing booking (with buffer on each side)
        const collides = existing.some((b) => {
          const bStart = new Date(b.scheduled_at).getTime();
          const bEnd =
            bStart + (b.duration_hours || 2) * 60 * 60 * 1000;
          return (
            slotStart < bEnd + buffer && slotEnd + buffer > bStart
          );
        });
        if (collides) continue;

        out.push({
          start: new Date(slotStart).toISOString(),
          end: new Date(slotEnd).toISOString(),
          label: this.formatIstLabel(new Date(slotStart)),
        });
      }
    }
    return out;
  }

  // ─── INTERNAL: validate a candidate booking time ──────
  // Called from BookingsService.createBooking. Throws on conflict.
  async assertSlotAvailable(
    cookId: string,
    scheduledAt: Date,
    durationHours: number,
    excludeBookingId?: string,
  ): Promise<void> {
    const cook = await this.cooksRepo.findOne({ where: { id: cookId } });
    if (!cook) throw new NotFoundException('Cook not found');

    const minAdvanceMs = (cook.min_advance_notice_minutes || 60) * 60 * 1000;
    if (scheduledAt.getTime() < Date.now() + minAdvanceMs) {
      const mins = cook.min_advance_notice_minutes || 60;
      throw new BadRequestException(
        `This chef requires at least ${mins} minutes advance notice. Please pick a later time.`,
      );
    }

    // Check inside an open window
    const dateYmd = this.utcToIstYmd(scheduledAt);
    const slotMinutes = this.istHmFromUtc(scheduledAt);

    const override = await this.overridesRepo.findOne({
      where: { cook_id: cookId, date: dateYmd },
    });
    let windows: { start: string; end: string }[] = [];
    if (override) {
      if (override.closed) {
        throw new BadRequestException(
          'Chef is not available on this date. Please pick another time.',
        );
      }
      windows = override.windows || [];
    } else {
      const weekday = this.weekdayIst(dateYmd);
      const sched = await this.schedulesRepo.findOne({
        where: { cook_id: cookId, weekday },
      });
      if (!sched || !sched.enabled) {
        throw new BadRequestException(
          'Chef is not available on this day of the week. Please pick another time.',
        );
      }
      windows = sched.windows || [];
    }

    const slotEndMin = slotMinutes + durationHours * 60;
    const fits = windows.some((w) => {
      const ws = this.toMinutes(w.start);
      const we = this.toMinutes(w.end);
      return slotMinutes >= ws && slotEndMin <= we;
    });
    if (!fits) {
      throw new BadRequestException(
        'Selected time falls outside the chef\'s working hours. Please pick an available slot.',
      );
    }

    // Conflict with existing bookings (+buffer)
    const buffer = (cook.booking_buffer_minutes || 30) * 60 * 1000;
    const slotStartMs = scheduledAt.getTime();
    const slotEndMs = slotStartMs + durationHours * 60 * 60 * 1000;

    const dayStart = this.istYmdHmToUtc(dateYmd, '00:00');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const where: any = {
      cook_id: cookId,
      status: In(BLOCKING_STATUSES),
      scheduled_at: Between(dayStart, dayEnd),
    };
    if (excludeBookingId) where.id = Not(excludeBookingId);

    const existing = await this.bookingsRepo.find({ where });
    const collides = existing.some((b) => {
      const bStart = new Date(b.scheduled_at).getTime();
      const bEnd = bStart + (b.duration_hours || 2) * 60 * 60 * 1000;
      return slotStartMs < bEnd + buffer && slotEndMs + buffer > bStart;
    });
    if (collides) {
      throw new BadRequestException(
        'This time slot is already booked. Please pick another available slot.',
      );
    }
  }

  // ─── helpers ──────────────────────────────────────────
  private validateWindows(windows: TimeWindowDto[], expectNonEmpty: boolean) {
    if (expectNonEmpty && (!windows || windows.length === 0)) {
      throw new BadRequestException(
        'At least one time window is required when enabled.',
      );
    }
    const sorted = [...(windows || [])].sort(
      (a, b) => this.toMinutes(a.start) - this.toMinutes(b.start),
    );
    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i];
      const s = this.toMinutes(w.start);
      const e = this.toMinutes(w.end);
      if (e <= s) {
        throw new BadRequestException(
          `Window ${w.start}-${w.end}: end must be after start.`,
        );
      }
      if (i > 0) {
        const prevEnd = this.toMinutes(sorted[i - 1].end);
        if (s < prevEnd) {
          throw new BadRequestException(
            `Window ${w.start}-${w.end} overlaps previous window.`,
          );
        }
      }
    }
  }

  private toMinutes(hm: string): number {
    const [h, m] = hm.split(':').map(Number);
    return h * 60 + m;
  }

  private todayIstYmd(): string {
    return this.utcToIstYmd(new Date());
  }

  private addDays(ymd: string, days: number): string {
    const d = new Date(ymd + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** UTC instant → IST YYYY-MM-DD */
  private utcToIstYmd(d: Date): string {
    const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60 * 1000);
    return ist.toISOString().slice(0, 10);
  }

  /** UTC instant → IST minutes-since-midnight */
  private istHmFromUtc(d: Date): number {
    const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60 * 1000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }

  /** IST date "YYYY-MM-DD" + "HH:mm" → UTC Date */
  private istYmdHmToUtc(ymd: string, hm: string): Date {
    const [h, m] = hm.split(':').map(Number);
    // IST midnight (date 00:00 IST) in UTC = date - 5:30
    const istMidnightUtcMs =
      Date.parse(ymd + 'T00:00:00.000Z') - IST_OFFSET_MIN * 60 * 1000;
    return new Date(istMidnightUtcMs + (h * 60 + m) * 60 * 1000);
  }

  /** IST weekday for a YYYY-MM-DD (0=Sun..6=Sat) */
  private weekdayIst(ymd: string): number {
    // Treat date as IST midnight, get weekday from that.
    const d = new Date(ymd + 'T00:00:00.000Z');
    return d.getUTCDay();
  }

  private formatIstLabel(utc: Date): string {
    const ist = new Date(utc.getTime() + IST_OFFSET_MIN * 60 * 1000);
    let h = ist.getUTCHours();
    const m = ist.getUTCMinutes();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
  }
}
