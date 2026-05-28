import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { PromoCode, PromoType } from './promo-code.entity';
import { PromoCodeUsage } from './promo-code-usage.entity';
import { Booking, BookingStatus } from '../bookings/booking.entity';

export interface ValidatePromoResult {
  valid: true;
  discount_amount: number;
  code: string;
  description: string;
}

@Injectable()
export class PromoCodesService {
  constructor(
    @InjectRepository(PromoCode)
    private promoCodesRepo: Repository<PromoCode>,
    @InjectRepository(PromoCodeUsage)
    private promoUsageRepo: Repository<PromoCodeUsage>,
    @InjectRepository(Booking)
    private bookingsRepo: Repository<Booking>,
  ) {}

  // ─── VALIDATE + CALCULATE DISCOUNT ────────────────────
  /**
   * Validates a promo code for a given user and order amount.
   * Returns the discount amount (already calculated).
   * Throws BadRequestException on any failure.
   */
  async validate(
    code: string,
    userId: string,
    orderAmount: number,
  ): Promise<ValidatePromoResult> {
    const promo = await this.promoCodesRepo.findOne({
      where: { code: code.toUpperCase().trim(), is_active: true },
    });

    if (!promo) throw new NotFoundException('Promo code not found or expired');

    const now = new Date();
    if (now < promo.valid_from) {
      throw new BadRequestException('Promo code is not yet active');
    }
    if (now > promo.valid_until) {
      throw new BadRequestException('Promo code has expired');
    }

    if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
      throw new BadRequestException('Promo code usage limit reached');
    }

    if (orderAmount < Number(promo.min_order)) {
      throw new BadRequestException(
        `Minimum order amount of ₹${promo.min_order} required for this code`,
      );
    }

    // Per-user usage check
    if (promo.max_uses_per_user !== null) {
      const userUsages = await this.promoUsageRepo.count({
        where: { promo_code_id: promo.id, user_id: userId },
      });
      if (userUsages >= promo.max_uses_per_user) {
        throw new BadRequestException('You have already used this promo code');
      }
    }

    // First booking only check
    if (promo.first_booking_only) {
      const existingBooking = await this.bookingsRepo.findOne({
        where: {
          user_id: userId,
          status: BookingStatus.COMPLETED,
        },
      });
      if (existingBooking) {
        throw new BadRequestException(
          'This promo code is only valid on your first booking',
        );
      }
    }

    // Calculate discount
    let discountAmount: number;
    if (promo.type === PromoType.FLAT) {
      discountAmount = Math.min(Number(promo.value), orderAmount);
    } else {
      // PERCENT
      const rawDiscount = (orderAmount * Number(promo.value)) / 100;
      discountAmount = promo.max_discount !== null
        ? Math.min(rawDiscount, Number(promo.max_discount))
        : rawDiscount;
    }

    discountAmount = Math.round(discountAmount * 100) / 100;

    return {
      valid: true,
      discount_amount: discountAmount,
      code: promo.code,
      description:
        promo.description ||
        (promo.type === PromoType.FLAT
          ? `₹${promo.value} off`
          : `${promo.value}% off`),
    };
  }

  // ─── APPLY (record usage) ──────────────────────────────
  /**
   * Records that a user used a promo code on a booking.
   * Call this AFTER a booking is successfully created.
   * Idempotent — won't double-record.
   */
  async apply(
    code: string,
    userId: string,
    bookingId: string,
    discountAmount: number,
  ): Promise<void> {
    const promo = await this.promoCodesRepo.findOne({
      where: { code: code.toUpperCase().trim() },
    });
    if (!promo) return;

    // Check not already recorded (idempotency)
    const existing = await this.promoUsageRepo.findOne({
      where: { promo_code_id: promo.id, booking_id: bookingId },
    });
    if (existing) return;

    await this.promoUsageRepo.save(
      this.promoUsageRepo.create({
        promo_code_id: promo.id,
        user_id: userId,
        booking_id: bookingId,
        discount_amount: discountAmount,
      }),
    );

    // Increment global usage counter atomically
    await this.promoCodesRepo.increment({ id: promo.id }, 'used_count', 1);
  }

  // ─── ADMIN CRUD ────────────────────────────────────────

  async create(dto: {
    code: string;
    type: PromoType;
    value: number;
    min_order?: number;
    max_discount?: number;
    max_uses?: number;
    max_uses_per_user?: number;
    valid_from: Date;
    valid_until: Date;
    first_booking_only?: boolean;
    description?: string;
  }): Promise<PromoCode> {
    const existing = await this.promoCodesRepo.findOne({
      where: { code: dto.code.toUpperCase().trim() },
    });
    if (existing) {
      throw new BadRequestException(`Code "${dto.code}" already exists`);
    }
    const promo = this.promoCodesRepo.create({
      ...dto,
      code: dto.code.toUpperCase().trim(),
    });
    return this.promoCodesRepo.save(promo);
  }

  async findAll(activeOnly = false): Promise<PromoCode[]> {
    const where = activeOnly
      ? { is_active: true, valid_until: MoreThan(new Date()) }
      : {};
    return this.promoCodesRepo.find({
      where,
      order: { created_at: 'DESC' },
    });
  }

  async findOne(id: string): Promise<PromoCode> {
    const promo = await this.promoCodesRepo.findOne({ where: { id } });
    if (!promo) throw new NotFoundException('Promo code not found');
    return promo;
  }

  async toggleActive(id: string): Promise<PromoCode> {
    const promo = await this.findOne(id);
    promo.is_active = !promo.is_active;
    return this.promoCodesRepo.save(promo);
  }

  async remove(id: string): Promise<void> {
    const promo = await this.findOne(id);
    await this.promoCodesRepo.remove(promo);
  }

  async getUsageStats(id: string) {
    const promo = await this.findOne(id);
    const usages = await this.promoUsageRepo.find({
      where: { promo_code_id: id },
      order: { used_at: 'DESC' },
      take: 50,
    });
    const totalDiscount = usages.reduce(
      (sum, u) => sum + Number(u.discount_amount),
      0,
    );
    return {
      promo,
      total_uses: promo.used_count,
      total_discount_given: Math.round(totalDiscount * 100) / 100,
      recent_usages: usages,
    };
  }
}
