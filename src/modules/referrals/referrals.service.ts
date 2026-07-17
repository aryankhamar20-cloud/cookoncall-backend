import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Referral, ReferralStatus } from './referral.entity';
import { User } from '../users/user.entity';
import { WalletService } from '../wallet/wallet.service';
import { WalletTxnType } from '../wallet/wallet-transaction.entity';

// Reward amounts (in ₹). Keep these in sync with the customer-facing copy
// on the app "Refer & Earn" screen and the web Refer & Earn panel.
const REFERRER_REWARD = 100; // referrer earns ₹100 after referred user's 1st booking
const REFEREE_DISCOUNT = 50; // referred user gets ₹50 off their 1st booking

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    @InjectRepository(Referral)
    private referralRepo: Repository<Referral>,
    @InjectRepository(User)
    private usersRepo: Repository<User>,
    private readonly walletService: WalletService,
  ) {}

  // ─── Generate deterministic referral code from user ID ─
  generateCode(userId: string): string {
    // e.g. "COC-A1B2C3" — first 6 chars of UUID uppercased
    return `COC-${userId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  }

  // ─── Get current user's referral code ────────────────
  async getMyReferralCode(userId: string): Promise<{
    code: string;
    total_referrals: number;
    rewarded_referrals: number;
    total_earned: number;
  }> {
    const code = this.generateCode(userId);

    const referrals = await this.referralRepo.find({
      where: { referrer_user_id: userId },
    });

    const rewarded = referrals.filter((r) => r.status === ReferralStatus.REWARDED);
    const totalEarned = rewarded.reduce(
      (sum, r) => sum + Number(r.referrer_reward),
      0,
    );

    return {
      code,
      total_referrals: referrals.length,
      rewarded_referrals: rewarded.length,
      total_earned: totalEarned,
    };
  }

  // ─── Apply referral code at registration ─────────────
  async applyReferralCode(referredUserId: string, code: string): Promise<void> {
    // Decode user ID from code
    const codePrefix = code.toUpperCase().replace('COC-', '');

    // Find the referrer by matching code prefix against their UUID
    const allUsers = await this.usersRepo
      .createQueryBuilder('u')
      .where(`REPLACE(UPPER(LEFT(u.id::text, 8)), '-', '') LIKE :prefix`, {
        prefix: `${codePrefix}%`,
      })
      .getMany();

    // Filter to exact match
    const referrer = allUsers.find(
      (u) => this.generateCode(u.id) === code.toUpperCase(),
    );

    if (!referrer) {
      throw new BadRequestException('Invalid referral code');
    }

    if (referrer.id === referredUserId) {
      throw new BadRequestException('You cannot use your own referral code');
    }

    // Check if this user was already referred
    const existing = await this.referralRepo.findOne({
      where: { referred_user_id: referredUserId },
    });
    if (existing) return; // Already referred — silently skip

    const referral = this.referralRepo.create({
      referrer_user_id: referrer.id,
      referred_user_id: referredUserId,
      referrer_reward: REFERRER_REWARD,
      referee_reward: REFEREE_DISCOUNT,
      status: ReferralStatus.PENDING,
    });

    await this.referralRepo.save(referral);

    // Deliver the referee's ₹50 immediately as spendable wallet credit
    // (usable on any booking via pay-with-wallet). Best-effort: a wallet
    // hiccup must not fail signup — the referral row is already saved.
    try {
      await this.walletService.credit(
        referredUserId,
        REFEREE_DISCOUNT,
        WalletTxnType.REFEREE_DISCOUNT,
        {
          referenceType: 'referral',
          referenceId: referral.id,
          description: 'Welcome bonus — referred by a friend',
        },
      );
    } catch (err) {
      this.logger.warn(
        `Referee wallet credit failed for ${referredUserId}: ${(err as Error).message}`,
      );
    }

    this.logger.log(`Referral recorded: ${referrer.id} → ${referredUserId}`);
  }

  // ─── Called after referred user completes first booking ─
  async onFirstBookingCompleted(userId: string, bookingId: string): Promise<void> {
    const referral = await this.referralRepo.findOne({
      where: {
        referred_user_id: userId,
        status: ReferralStatus.PENDING,
      },
    });

    if (!referral) return; // Not a referred user or already rewarded

    referral.status = ReferralStatus.REWARDED;
    referral.rewarded_booking_id = bookingId;
    await this.referralRepo.save(referral);

    // Deliver the referrer's ₹100 as real wallet credit.
    try {
      await this.walletService.credit(
        referral.referrer_user_id,
        Number(referral.referrer_reward),
        WalletTxnType.REFERRAL_REWARD,
        {
          referenceType: 'referral',
          referenceId: referral.id,
          description: 'Referral reward — your friend completed their first booking',
        },
      );
      this.logger.log(
        `Referral rewarded: referrer=${referral.referrer_user_id} credited ₹${referral.referrer_reward}`,
      );
    } catch (err) {
      this.logger.error(
        `Referrer wallet credit FAILED for ${referral.referrer_user_id}: ${(err as Error).message}`,
      );
      // Roll the referral back to PENDING so a retry (next completed booking
      // sweep or manual) can re-attempt — never silently lose the reward.
      referral.status = ReferralStatus.PENDING;
      referral.rewarded_booking_id = null;
      await this.referralRepo.save(referral);
    }
  }

  // ─── Get referee discount amount ─────────────────────
  async getRefereeDiscount(userId: string): Promise<number> {
    const referral = await this.referralRepo.findOne({
      where: { referred_user_id: userId, status: ReferralStatus.PENDING },
    });
    return referral ? Number(referral.referee_reward) : 0;
  }

  // ─── ADMIN: Get all referrals ─────────────────────────
  async findAll(page = 1, limit = 20) {
    const [referrals, total] = await this.referralRepo.findAndCount({
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { referrals, total, page, limit };
  }
}
