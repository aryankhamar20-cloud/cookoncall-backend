import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Subscription } from './subscription.entity';

/**
 * One materialized session generated from a subscription. Links a
 * subscription to the concrete `booking` the cron created, so we never
 * double-generate the same slot and can show the customer their upcoming
 * recurring sessions.
 */
export enum SubscriptionRunStatus {
  SCHEDULED = 'scheduled', // booking created, upcoming
  SKIPPED = 'skipped', // chef unavailable / generation skipped
  FULFILLED = 'fulfilled', // underlying booking completed
  CANCELLED = 'cancelled',
}

@Entity('subscription_runs')
@Index(['subscription_id', 'scheduled_for'], { unique: true })
export class SubscriptionRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  subscription_id: string;

  @ManyToOne(() => Subscription, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subscription_id' })
  subscription: Subscription;

  /** The concrete booking this run generated (null if skipped). */
  @Column({ type: 'uuid', nullable: true })
  booking_id: string | null;

  @Column({ type: 'timestamptz' })
  scheduled_for: Date;

  @Column({
    type: 'enum',
    enum: SubscriptionRunStatus,
    default: SubscriptionRunStatus.SCHEDULED,
  })
  status: SubscriptionRunStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
