import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Cook } from '../cooks/cook.entity';
import { User } from '../users/user.entity';

/**
 * Recurring meal-plan subscription. A customer subscribes to a chef on a
 * cadence (e.g. weekly, Mon/Wed/Fri, 8pm). A scheduler cron materializes
 * upcoming sessions into real `bookings` a few days ahead, so each generated
 * session behaves exactly like a one-off booking (payment, OTP, receipt,
 * review). Pausing stops generation; cancelling ends the plan.
 */
export enum SubscriptionCadence {
  WEEKLY = 'weekly',
  BIWEEKLY = 'biweekly',
  MONTHLY = 'monthly',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  CANCELLED = 'cancelled',
}

@Entity('subscriptions')
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Index()
  @Column({ type: 'uuid' })
  cook_id: string;

  @ManyToOne(() => Cook, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cook_id' })
  cook: Cook;

  /** Optional meal package this subscription is built around (for display). */
  @Column({ type: 'uuid', nullable: true })
  meal_package_id: string | null;

  /**
   * Snapshot of the booking create-payload captured at subscribe time
   * (packageId + guestCount + selectedCategories/items + address +
   * area_slug + instructions, minus scheduled_at). The generation cron
   * replays this through BookingsService.createBooking with a computed
   * date, so every recurring session reuses the exact pricing, availability
   * and validation logic as a one-off booking.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  booking_template: Record<string, unknown>;

  @Column({ type: 'enum', enum: SubscriptionCadence, default: SubscriptionCadence.WEEKLY })
  cadence: SubscriptionCadence;

  /** Days of week to cook on: 0=Sun … 6=Sat. e.g. [1,3,5]. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  days_of_week: number[];

  /** Local time-of-day for each session, "HH:mm" (24h). */
  @Column({ type: 'varchar', length: 5, default: '20:00' })
  time_slot: string;

  /** Delivery/service address for every generated booking. */
  @Column({ type: 'uuid', nullable: true })
  address_id: string | null;

  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.ACTIVE })
  status: SubscriptionStatus;

  /** Price charged per generated session (snapshot at subscribe time). */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price_per_session: number;

  /** Next datetime the cron should generate a session for. */
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  next_run_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  started_at: Date | null;

  /** Optional end date; null = open-ended until cancelled. */
  @Column({ type: 'timestamptz', nullable: true })
  ends_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
