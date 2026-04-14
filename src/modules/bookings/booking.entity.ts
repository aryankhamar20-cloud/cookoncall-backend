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
    default: BookingStatus.PENDING,
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

  @Column({ type: 'text', nullable: true })
  cancellation_reason: string;

  // ─── COOKING SESSION OTP ─────────────────────────────
  // Start OTP: sent to customer when chef clicks "Start Cooking"
  @Column({ type: 'varchar', length: 6, nullable: true })
  start_otp: string;

  @Column({ type: 'timestamptz', nullable: true })
  start_otp_expires_at: Date;

  // End OTP: sent to customer when chef clicks "End Session"
  @Column({ type: 'varchar', length: 6, nullable: true })
  end_otp: string;

  @Column({ type: 'timestamptz', nullable: true })
  end_otp_expires_at: Date;

  // Actual cooking duration in minutes (calculated from started_at to completed_at)
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
