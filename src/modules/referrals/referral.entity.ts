import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';

export enum ReferralStatus {
  PENDING   = 'pending',    // referred user signed up but not completed first booking
  REWARDED  = 'rewarded',   // first booking completed — reward issued
}

@Entity('referrals')
@Unique(['referred_user_id'])  // a user can only be referred once
export class Referral {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  referrer_user_id: string;   // the user who shared their code

  @Column()
  referred_user_id: string;   // the new user who used the referral code

  @Column({ type: 'enum', enum: ReferralStatus, default: ReferralStatus.PENDING })
  status: ReferralStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  referrer_reward: number;    // amount credited to referrer (e.g. ₹50)

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  referee_reward: number;     // discount given to referred user on first booking

  @Column({ nullable: true })
  rewarded_booking_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
