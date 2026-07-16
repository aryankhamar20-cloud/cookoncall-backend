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

/**
 * Payout settlement ledger — one row per money transfer a platform admin
 * makes to a chef.
 *
 * Phase 1 (now): MANUAL settlement. The admin pays the chef out-of-band
 * (UPI / bank transfer) and records it here with a reference so we have an
 * auditable trail and each chef's outstanding balance is always
 * `total earned − SUM(paid payouts)`.
 *
 * Phase 2 (after scaling): Razorpay Route. The same table absorbs
 * auto-transfers — `method = 'razorpay'` and `reference` holds the Route
 * transfer id — so the ledger and the chef-facing history don't change
 * shape when we automate.
 */
export enum PayoutStatus {
  PENDING = 'pending', // recorded, not yet sent
  PROCESSING = 'processing', // transfer initiated (Route / bank in-flight)
  PAID = 'paid', // settled to the chef
  FAILED = 'failed', // transfer failed / reversed
}

export enum PayoutMethod {
  UPI = 'upi',
  BANK_TRANSFER = 'bank_transfer',
  CASH = 'cash',
  RAZORPAY = 'razorpay', // Phase 2 — Route auto-transfer
  OTHER = 'other',
}

@Entity('payouts')
export class Payout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  cook_id: string;

  @ManyToOne(() => Cook, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cook_id' })
  cook: Cook;

  /** Amount settled to the chef, in ₹. */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'enum', enum: PayoutStatus, default: PayoutStatus.PENDING })
  status: PayoutStatus;

  @Column({ type: 'enum', enum: PayoutMethod, nullable: true })
  method: PayoutMethod | null;

  /** UTR / UPI txn id / Razorpay transfer id — for reconciliation. */
  @Column({ type: 'varchar', nullable: true })
  reference: string | null;

  /** Free-text admin note (e.g. "covers Jul 1–15 bookings"). */
  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** How many completed bookings this payout covers (informational). */
  @Column({ type: 'int', default: 0 })
  booking_count: number;

  /** Optional settlement period this payout covers. */
  @Column({ type: 'timestamptz', nullable: true })
  period_start: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  period_end: Date | null;

  /** Admin user id who recorded the payout (audit trail). */
  @Column({ type: 'uuid', nullable: true })
  created_by: string | null;

  /** When the money actually reached the chef. */
  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
