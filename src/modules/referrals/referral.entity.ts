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

export enum ReferralStatus {
  PENDING = 'pending',       // referred user signed up but hasn't booked yet
  COMPLETED = 'completed',   // referred user completed first booking — reward credited
  EXPIRED = 'expired',       // 30 days passed without qualifying booking
}

/**
 * Tracks referral relationships.
 * referrer → referred_user → first booking → both get reward.
 */
@Entity('referrals')
@Index(['referrer_id'])
@Index(['referred_id'], { unique: true }) // one referral per new user
export class Referral {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // The user who shared the referral link
  @Column({ type: 'uuid' })
  referrer_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'referrer_id' })
  referrer: User;

  // The new user who signed up via the referral link
  @Column({ type: 'uuid' })
  referred_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'referred_id' })
  referred: User;

  // Referral code that was used (snapshot of referrer's code at time of signup)
  @Column({ length: 10 })
  code: string;

  @Column({
    type: 'enum',
    enum: ReferralStatus,
    default: ReferralStatus.PENDING,
  })
  status: ReferralStatus;

  // Credit amount for referrer (default ₹100 in promo form)
  @Column({ type: 'decimal', precision: 8, scale: 2, default: 100 })
  reward_amount: number;

  // When reward was credited (both parties)
  @Column({ type: 'timestamptz', nullable: true })
  credited_at: Date;

  // The booking that qualified for reward (referred user's first booking)
  @Column({ type: 'uuid', nullable: true })
  qualifying_booking_id: string;

  // Referral expires if not converted within 30 days
  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
