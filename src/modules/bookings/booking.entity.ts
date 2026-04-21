import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToOne,
} from 'typeorm';
import { User } from '../users/user.entity';
import { Cook } from '../cooks/cook.entity';

export enum BookingStatus {
  // ─── NEW FLOW (Apr 21, 2026) ─────────────────────────
  // Customer books → chef has 3hr to accept/reject
  PENDING_CHEF_APPROVAL = 'pending_chef_approval',
  // Chef accepted → customer has 3hr to pay
  AWAITING_PAYMENT = 'awaiting_payment',
  // ─── LEGACY (kept for backward-compat with old DB rows) ─
  // `pending` rows get migrated to `pending_chef_approval` via SQL.
  // We keep the enum value so old rows don't break TypeORM reads.
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED_BY_USER = 'cancelled_by_user',
  CANCELLED_BY_COOK = 'cancelled_by_cook',
  EXPIRED = 'expired',
}

export enum BookingType {
  HOME_COOKING = 'home_cooking',
  FOOD_DELIVERY = 'food_delivery',
}

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid' })
  cook_id: string;

  @ManyToOne(() => Cook, { eager: true })
  @JoinColumn({ name: 'cook_id' })
  cook: Cook;

  @Column({
    type: 'enum',
    enum: BookingStatus,
    default: BookingStatus.PENDING_CHEF_APPROVAL,
  })
  status: BookingStatus;

  @Column({
    type: 'enum',
    enum: BookingType,
    default: BookingType.HOME_COOKING,
  })
  booking_type: BookingType;

  @Column({ type: 'timestamptz' })
  scheduled_at: Date;

  @Column({ type: 'int', default: 2 })
  duration_hours: number;

  @Column({ type: 'int', default: 2 })
  guests: number;

  @Column({ type: 'text' })
  address: string;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude: number;

  @Column({ type: 'text', nullable: true })
  dishes: string;

  @Column({ type: 'text', nullable: true })
  instructions: string;

  // For food delivery orders — JSON array of {menuItemId, name, qty, price}
  @Column({ type: 'jsonb', nullable: true })
  order_items: Record<string, any>[];

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  subtotal: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  platform_fee: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  total_price: number;

  // ─── LAUNCH PRICING (Apr 19, 2026) ───────────────────
  @Column({ type: 'int', default: 49 })
  visit_fee: number;

  @Column({ type: 'decimal', precision: 4, scale: 2, default: 2.5 })
  platform_fee_percent: number;

  @Column({ type: 'text', nullable: true })
  cancellation_reason: string;

  // ─── CHEF REJECTION (Apr 21, 2026) ───────────────────
  // Internal-only. MUST NOT be returned to customer endpoints.
  @Column({ type: 'text', nullable: true })
  rejection_reason: string;

  // Timestamp set when chef accepts OR rejects.
  @Column({ type: 'timestamptz', nullable: true })
  chef_responded_at: Date;

  // Set to chef_responded_at + 3h when chef accepts. Used for on-demand expiry.
  @Column({ type: 'timestamptz', nullable: true })
  payment_expires_at: Date;

  // Link to the rebooked/replacement booking when a customer chooses
  // "book another chef" after rejection. Lets us show a chain in admin.
  @Column({ type: 'uuid', nullable: true })
  rebooked_to_id: string;

  // ─── COOKING SESSION OTP ─────────────────────────────
  @Column({ type: 'varchar', length: 6, nullable: true })
  start_otp: string;

  @Column({ type: 'timestamptz', nullable: true })
  start_otp_expires_at: Date;

  @Column({ type: 'varchar', length: 6, nullable: true })
  end_otp: string;

  @Column({ type: 'timestamptz', nullable: true })
  end_otp_expires_at: Date;

  @Column({ type: 'int', nullable: true })
  actual_duration_minutes: number;

  // ─── CANCELLATION REFUND ─────────────────────────────
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  refund_amount: number;

  // ─── TIMESTAMPS ──────────────────────────────────────
  @Column({ type: 'timestamptz', nullable: true })
  confirmed_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  started_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  cancelled_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
