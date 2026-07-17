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
import { Booking } from '../bookings/booking.entity';
import { User } from '../users/user.entity';

/**
 * A dispute / issue raised on a booking by either the customer or the chef.
 * Admin reviews and resolves; an optional refund_amount records what was
 * (manually) refunded as part of the resolution — we do NOT move money here,
 * we record the decision for the payout/refund process to honour.
 */
export enum DisputeStatus {
  OPEN = 'open',
  UNDER_REVIEW = 'under_review',
  RESOLVED = 'resolved',
  REJECTED = 'rejected',
}

export enum DisputeParty {
  CUSTOMER = 'customer',
  COOK = 'cook',
}

@Entity('disputes')
export class Dispute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  booking_id: string;

  @ManyToOne(() => Booking, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking: Booking;

  /** The user who raised it. */
  @Index()
  @Column({ type: 'uuid' })
  raised_by_user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'raised_by_user_id' })
  raised_by: User;

  @Column({ type: 'enum', enum: DisputeParty })
  raised_by_role: DisputeParty;

  /** Short category, e.g. 'quality', 'no_show', 'payment', 'behaviour', 'other'. */
  @Column({ type: 'varchar', length: 40 })
  reason: string;

  @Column({ type: 'text' })
  description: string;

  @Index()
  @Column({ type: 'enum', enum: DisputeStatus, default: DisputeStatus.OPEN })
  status: DisputeStatus;

  @Column({ type: 'text', nullable: true })
  resolution_note: string | null;

  /** Refund decided during resolution (recorded, not executed). */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  refund_amount: number | null;

  /** Admin user id who resolved it. */
  @Column({ type: 'uuid', nullable: true })
  resolved_by: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
