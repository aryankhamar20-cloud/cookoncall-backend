import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

export enum NotificationType {
  BOOKING_CREATED = 'booking_created',
  BOOKING_CONFIRMED = 'booking_confirmed',
  BOOKING_CANCELLED = 'booking_cancelled',
  BOOKING_COMPLETED = 'booking_completed',
  BOOKING_STARTED = 'booking_started',
  // New (Apr 21, 2026): booking flow events
  BOOKING_CHEF_ACCEPTED = 'booking_chef_accepted', // customer: pay within 3 hrs
  BOOKING_CHEF_REJECTED = 'booking_chef_rejected', // customer: rebook or close (NO reason)
  BOOKING_EXPIRED = 'booking_expired',             // either party: window lapsed
  PAYMENT_REMINDER = 'payment_reminder',           // customer: pay reminder
  COOK_ON_WAY = 'cook_on_way',
  PAYMENT_RECEIVED = 'payment_received',
  PAYMENT_RELEASED = 'payment_released',
  REVIEW_RECEIVED = 'review_received',
  REVIEW_PROMPT = 'review_prompt',
  COOK_VERIFIED = 'cook_verified',
  COOK_REJECTED = 'cook_rejected',
  OTP_SENT = 'otp_sent',
  GENERAL = 'general',
}

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: NotificationType })
  type: NotificationType;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ default: false })
  is_read: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
