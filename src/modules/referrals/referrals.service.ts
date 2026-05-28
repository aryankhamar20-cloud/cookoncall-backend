import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Referral, ReferralStatus } from './referral.entity';
import { User } from '../users/user.entity';
import { PromoCode, PromoType } from '../promo-codes/promo-code.entity';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);
  private readonly rewardAmount: number;
  private readonly expiryDays = 30;

  constructor(
    @InjectRepository(Referral)
    private referralsRepo: Repository<Referral>,
    @InjectRepository(User)
    private usersRepo: Repository<User>,
    @InjectRepository(PromoCode)
    private promoCodesRepo: Repository<PromoCode>,
    private configService: ConfigService,
  ) {
    this.rewardAmount = Number(
      this.configService.get<number>('REFERRAL_REWARD_AMOUNT', 100),
    );
  }

  // ─── GET OR CREATE REFERRAL CODE FOR USER ─────────────
  /**
   * Every user has a unique referral code: first 6 chars of UUID + 4-digit random.
   * Deterministic — same user always gets the same code.
   */
  async getReferralCode(userId: string): Promise<{ code: string; reward_amount: number }> {
    // Generate deterministic code from userId
    const code = this.generateCode(userId);
    return { code, reward_amount: this.rewardAmount };
  }

  private generateCode(userId: string): string {
    // Use first 6 chars of UUID (strip hyphens) uppercased
    const base = userId.replace(/-/g, '').substring(0, 6).toUpperCase();
    return `COC${base}`;
  }

  // ─── APPLY REFERRAL CODE ON SIGNUP ────────────────────
  /**
   * Called after a new user registers, if they provided a referral code.
   * Creates a PENDING referral record.
   */
  async applyOnSignup(newUserId: string, referralCode: string): Promise<void> {
    const code = referralCode.toUpperCase().trim();

    // Find the referrer by their code
    const allUsers = await this.usersRepo.find({ select: ['id'] });
    let referrerId: string | null = null;

    for (const user of allUsers) {
      if (this.generateCode(user.id) === code) {
        referrerId = user.id;
        break;
      }
    }

    if (!referrerId) {
      this.logger.warn(`Referral code ${code} not matched to any user`);
      return; // Silently ignore invalid codes
    }

    if (referrerId === newUserId) {
      throw new BadRequestException('You cannot use your own referral code');
    }

    // Check if this new user already has a referral
    const existing = await this.referralsRepo.findOne({
      where: { referred_id: newUserId },
    });
    if (existing) return; // Already referred — skip silently

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.expiryDays);

    await this.referralsRepo.save(
      this.referralsRepo.create({
        referrer_id: referrerId,
        referred_id: newUserId,
        code,
        status: ReferralStatus.PENDING,
        reward_amount: this.rewardAmount,
        expires_at: expiresAt,
      }),
    );

    this.logger.log(
      `Referral created: ${referrerId} → ${newUserId} (code: ${code})`,
    );
  }

  // ─── COMPLETE REFERRAL ON FIRST BOOKING ───────────────
  /**
   * Called when a referred user completes their first booking.
   * Credits both users with promo codes.
   */
  async completeOnFirstBooking(
    referredUserId: string,
    bookingId: string,
  ): Promise<void> {
    const referral = await this.referralsRepo.findOne({
      where: { referred_id: referredUserId, status: ReferralStatus.PENDING },
      relations: ['referrer', 'referred'],
    });

    if (!referral) return; // No pending referral

    if (new Date() > referral.expires_at) {
      await this.referralsRepo.update(referral.id, {
        status: ReferralStatus.EXPIRED,
      });
      return;
    }

    // Credit both users with promo codes
    const now = new Date();
    const expiresIn30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    await Promise.all([
      // Referrer reward
      this.createRewardPromo(
        `RREF${referral.referrer_id.replace(/-/g, '').substring(0, 8).toUpperCase()}`,
        referral.referrer_id,
        expiresIn30Days,
      ),
      // Referred user reward
      this.createRewardPromo(
        `RNEW${referral.referred_id.replace(/-/g, '').substring(0, 8).toUpperCase()}`,
        referral.referred_id,
        expiresIn30Days,
      ),
    ]);

    // Mark referral as completed
    await this.referralsRepo.update(referral.id, {
      status: ReferralStatus.COMPLETED,
      credited_at: now,
      qualifying_booking_id: bookingId,
    });

    this.logger.log(
      `Referral completed: both ${referral.referrer_id} and ${referredUserId} receive ₹${this.rewardAmount} reward`,
    );
  }

  private async createRewardPromo(
    code: string,
    userId: string,
    validUntil: Date,
  ): Promise<void> {
    // Check if this exact code already exists (idempotency)
    const existing = await this.promoCodesRepo.findOne({ where: { code } });
    if (existing) return;

    await this.promoCodesRepo.save(
      this.promoCodesRepo.create({
        code,
        type: PromoType.FLAT,
        value: this.rewardAmount,
        min_order: 200, // Minimum ₹200 order to use referral reward
        max_uses: 1,
        max_uses_per_user: 1,
        valid_from: new Date(),
        valid_until: validUntil,
        is_active: true,
        description: `Referral reward — ₹${this.rewardAmount} off your next order`,
      }),
    );
  }

  // ─── GET REFERRAL STATS FOR USER ──────────────────────
  async getUserReferralStats(userId: string) {
    const code = this.generateCode(userId);

    const referrals = await this.referralsRepo.find({
      where: { referrer_id: userId },
      order: { created_at: 'DESC' },
    });

    const completed = referrals.filter(
      (r) => r.status === ReferralStatus.COMPLETED,
    );
    const pending = referrals.filter(
      (r) => r.status === ReferralStatus.PENDING,
    );

    return {
      referral_code: code,
      reward_per_referral: this.rewardAmount,
      total_referrals: referrals.length,
      completed_referrals: completed.length,
      pending_referrals: pending.length,
      total_earned: completed.length * this.rewardAmount,
      referrals: referrals.map((r) => ({
        id: r.id,
        status: r.status,
        credited_at: r.credited_at,
        created_at: r.created_at,
      })),
    };
  }

  // ─── ADMIN ─────────────────────────────────────────────
  async getAllReferrals(page = 1, limit = 20) {
    const [referrals, total] = await this.referralsRepo.findAndCount({
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
      relations: ['referrer', 'referred'],
    });

    return {
      referrals,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }
}
