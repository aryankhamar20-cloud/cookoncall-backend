import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payout, PayoutStatus, PayoutMethod } from './payout.entity';
import { Cook } from '../cooks/cook.entity';
import { Booking, BookingStatus } from '../bookings/booking.entity';

export interface CookBalance {
  cook_id: string;
  cook_name: string | null;
  total_earned: number;
  total_paid: number;
  outstanding: number;
  completed_bookings: number;
}

@Injectable()
export class PayoutsService {
  constructor(
    @InjectRepository(Payout)
    private readonly payoutRepo: Repository<Payout>,
    @InjectRepository(Cook)
    private readonly cookRepo: Repository<Cook>,
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
  ) {}

  // ─── Chef earnings (net) from completed bookings ─────────────
  private async earnedForCook(cookId: string): Promise<{ total: number; count: number }> {
    const row = await this.bookingRepo
      .createQueryBuilder('b')
      .select('COALESCE(SUM(b.subtotal - b.platform_fee), 0)', 'total')
      .addSelect('COUNT(b.id)', 'count')
      .where('b.cook_id = :cookId', { cookId })
      .andWhere('b.status = :status', { status: BookingStatus.COMPLETED })
      .getRawOne<{ total: string; count: string }>();
    return { total: Number(row?.total ?? 0), count: Number(row?.count ?? 0) };
  }

  private async paidForCook(cookId: string): Promise<number> {
    const row = await this.payoutRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.amount), 0)', 'total')
      .where('p.cook_id = :cookId', { cookId })
      .andWhere('p.status = :status', { status: PayoutStatus.PAID })
      .getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }

  /** Outstanding balance for a single chef. */
  async balanceForCook(cookId: string): Promise<CookBalance> {
    const cook = await this.cookRepo.findOne({
      where: { id: cookId },
      relations: ['user'],
    });
    if (!cook) throw new NotFoundException('Chef not found');

    const earned = await this.earnedForCook(cookId);
    const paid = await this.paidForCook(cookId);
    return {
      cook_id: cookId,
      cook_name: cook.user?.name ?? null,
      total_earned: +earned.total.toFixed(2),
      total_paid: +paid.toFixed(2),
      outstanding: +(earned.total - paid).toFixed(2),
      completed_bookings: earned.count,
    };
  }

  /** Admin: outstanding balances for every chef who has earned anything. */
  async allBalances(): Promise<CookBalance[]> {
    const cooks = await this.cookRepo.find({ relations: ['user'] });
    const balances = await Promise.all(
      cooks.map((c) => this.balanceForCook(c.id)),
    );
    // Only surface chefs with money owed or already settled — hide the
    // long tail of chefs who've never completed a booking.
    return balances
      .filter((b) => b.total_earned > 0 || b.total_paid > 0)
      .sort((a, b) => b.outstanding - a.outstanding);
  }

  /** Chef-facing payout history (newest first). */
  async listForCookUser(userId: string): Promise<Payout[]> {
    const cook = await this.cookRepo.findOne({ where: { user_id: userId } });
    if (!cook) throw new NotFoundException('Chef profile not found');
    return this.payoutRepo.find({
      where: { cook_id: cook.id },
      order: { created_at: 'DESC' },
    });
  }

  /** Admin: recent payout records across all chefs. */
  async adminList(page = 1, limit = 20): Promise<{ payouts: Payout[]; total: number }> {
    const [payouts, total] = await this.payoutRepo.findAndCount({
      relations: ['cook', 'cook.user'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { payouts, total };
  }

  /**
   * Admin records a payout. Guards against over-paying: the amount can't
   * exceed the chef's current outstanding balance (with a tiny epsilon for
   * rounding). If marked paid immediately, sets paid_at.
   */
  async create(
    adminId: string,
    dto: {
      cook_id: string;
      amount: number;
      method?: PayoutMethod;
      reference?: string;
      notes?: string;
      period_start?: string;
      period_end?: string;
      mark_paid?: boolean;
    },
  ): Promise<Payout> {
    const balance = await this.balanceForCook(dto.cook_id);
    if (dto.amount <= 0) {
      throw new BadRequestException('Payout amount must be greater than zero');
    }
    if (dto.amount > balance.outstanding + 0.01) {
      throw new BadRequestException(
        `Amount ₹${dto.amount} exceeds the chef's outstanding balance of ₹${balance.outstanding}`,
      );
    }

    const payout = this.payoutRepo.create({
      cook_id: dto.cook_id,
      amount: dto.amount,
      method: dto.method ?? null,
      reference: dto.reference ?? null,
      notes: dto.notes ?? null,
      booking_count: balance.completed_bookings,
      period_start: dto.period_start ? new Date(dto.period_start) : null,
      period_end: dto.period_end ? new Date(dto.period_end) : null,
      created_by: adminId,
      status: dto.mark_paid ? PayoutStatus.PAID : PayoutStatus.PENDING,
      paid_at: dto.mark_paid ? new Date() : null,
    });
    return this.payoutRepo.save(payout);
  }

  /** Admin marks a pending payout as paid (records method + reference). */
  async markPaid(
    id: string,
    dto: { method?: PayoutMethod; reference?: string },
  ): Promise<Payout> {
    const payout = await this.payoutRepo.findOne({ where: { id } });
    if (!payout) throw new NotFoundException('Payout not found');
    if (payout.status === PayoutStatus.PAID) {
      throw new BadRequestException('Payout is already marked paid');
    }
    payout.status = PayoutStatus.PAID;
    payout.paid_at = new Date();
    if (dto.method) payout.method = dto.method;
    if (dto.reference) payout.reference = dto.reference;
    return this.payoutRepo.save(payout);
  }
}
