import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PromoCode, PromoType } from './promo-code.entity';
import { PromoCodeUsage } from './promo-code-usage.entity';
import { CreatePromoCodeDto, ValidatePromoCodeDto } from './dto/promo-code.dto';

@Injectable()
export class PromoCodesService {
  constructor(
    @InjectRepository(PromoCode)
    private promoRepo: Repository<PromoCode>,
    @InjectRepository(PromoCodeUsage)
    private usageRepo: Repository<PromoCodeUsage>,
  ) {}

  // ─── ADMIN: Create a promo code ───────────────────────
  async create(dto: CreatePromoCodeDto): Promise<PromoCode> {
    const existing = await this.promoRepo.findOne({
      where: { code: dto.code.toUpperCase() },
    });
    if (existing) throw new ConflictException('Promo code already exists');

    const promo = this.promoRepo.create({
      ...dto,
      code: dto.code.toUpperCase(),
      expires_at: dto.expires_at ? new Date(dto.expires_at) : null,
    });

    return this.promoRepo.save(promo);
  }

  // ─── ADMIN: List all promo codes ──────────────────────
  async findAll(): Promise<PromoCode[]> {
    return this.promoRepo.find({ order: { created_at: 'DESC' } });
  }

  // ─── ADMIN: Toggle active status ─────────────────────
  async toggle(id: string): Promise<PromoCode> {
    const promo = await this.promoRepo.findOne({ where: { id } });
    if (!promo) throw new NotFoundException('Promo code not found');
    promo.is_active = !promo.is_active;
    return this.promoRepo.save(promo);
  }

  // ─── CUSTOMER: Validate promo code ───────────────────
  async validate(
    userId: string,
    dto: ValidatePromoCodeDto,
  ): Promise<{
    valid: boolean;
    discount: number;
    final_amount: number;
    promo: Partial<PromoCode>;
    message: string;
  }> {
    const promo = await this.promoRepo.findOne({
      where: { code: dto.code.toUpperCase(), is_active: true },
    });

    if (!promo) {
      throw new BadRequestException('Invalid or expired promo code');
    }

    // Check expiry
    if (promo.expires_at && new Date() > promo.expires_at) {
      throw new BadRequestException('This promo code has expired');
    }

    // Check global usage cap
    if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
      throw new BadRequestException('This promo code has reached its usage limit');
    }

    // Check single-use per user
    if (promo.single_use) {
      const alreadyUsed = await this.usageRepo.findOne({
        where: { promo_code_id: promo.id, user_id: userId },
      });
      if (alreadyUsed) {
        throw new BadRequestException('You have already used this promo code');
      }
    }

    // Check minimum order
    if (dto.order_amount < Number(promo.min_order_amount)) {
      throw new BadRequestException(
        `Minimum order amount of ₹${promo.min_order_amount} required for this promo`,
      );
    }

    // Calculate discount
    const discount = this.calculateDiscount(promo, dto.order_amount);
    const final_amount = Math.max(0, dto.order_amount - discount);

    return {
      valid: true,
      discount,
      final_amount,
      promo: {
        id: promo.id,
        code: promo.code,
        type: promo.type,
        value: promo.value,
        description: promo.description,
      },
      message: `Promo applied! You save ₹${discount.toFixed(0)}`,
    };
  }

  // ─── INTERNAL: Record usage after booking confirmed ──
  async recordUsage(
    promoId: string,
    userId: string,
    bookingId: string,
    discountApplied: number,
  ): Promise<void> {
    const usage = this.usageRepo.create({
      promo_code_id: promoId,
      user_id: userId,
      booking_id: bookingId,
      discount_applied: discountApplied,
    });
    await this.usageRepo.save(usage);
    await this.promoRepo.increment({ id: promoId }, 'used_count', 1);
  }

  // ─── INTERNAL: Calculate discount amount ─────────────
  calculateDiscount(promo: PromoCode, orderAmount: number): number {
    let discount = 0;

    if (promo.type === PromoType.FLAT) {
      discount = Number(promo.value);
    } else if (promo.type === PromoType.PERCENTAGE) {
      discount = (orderAmount * Number(promo.value)) / 100;
      if (promo.max_discount) {
        discount = Math.min(discount, Number(promo.max_discount));
      }
    } else if (promo.type === PromoType.FREE_VISIT) {
      // Visit fee waived — handled in booking service; return 0 here
      discount = 0;
    }

    return Math.round(discount * 100) / 100;
  }
}
