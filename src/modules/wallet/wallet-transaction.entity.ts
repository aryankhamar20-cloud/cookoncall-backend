import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../users/user.entity';

/**
 * Wallet ledger — one row per credit/debit against a user's balance.
 *
 * Balance = SUM(amount). `amount` is signed: credits are positive
 * (referral reward, refund credit), debits are negative (paying part of a
 * booking from wallet). `balance_after` snapshots the running balance at
 * insert time for statements. The WalletService enforces that a debit can
 * never drive the balance below zero.
 *
 * This is what makes referrals real: the referrer's ₹100 lands here as a
 * `referral_reward` credit they can spend on future bookings.
 */
export enum WalletTxnType {
  REFERRAL_REWARD = 'referral_reward', // +₹ to referrer when referee completes 1st booking
  REFEREE_DISCOUNT = 'referee_discount', // record of ₹50 off applied at first booking
  REFUND_CREDIT = 'refund_credit', // cancellation refund issued as wallet credit
  BOOKING_PAYMENT = 'booking_payment', // -₹ spending wallet balance on a booking
  ADJUSTMENT = 'adjustment', // manual admin correction
}

@Entity('wallet_transactions')
export class WalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** Signed amount in ₹: positive = credit, negative = debit. */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  /** Running balance immediately after this transaction (for statements). */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  balance_after: number;

  @Column({ type: 'enum', enum: WalletTxnType })
  type: WalletTxnType;

  /** What this relates to, e.g. 'booking' | 'referral' | 'manual'. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  reference_type: string | null;

  @Column({ type: 'uuid', nullable: true })
  reference_id: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  description: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
