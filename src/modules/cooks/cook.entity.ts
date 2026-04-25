import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { User } from '../users/user.entity';

export enum VerificationStatus {
  NOT_SUBMITTED = 'not_submitted',
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

// ─── SERVICE ROLE ─────────────────────────────────────────
// What the chef actually does on-site.
// home_cook  = cooks fresh at the customer's kitchen (default)
// delivery   = prepares at own place, delivers / drops off
// both       = both home cooking and delivery
export enum ServiceRole {
  HOME_COOK = 'home_cook',
  DELIVERY = 'delivery',
  BOTH = 'both',
}

@Entity('cooks')
export class Cook {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @OneToOne(() => User, { eager: true })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'text', nullable: true })
  bio: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  pincode: string;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude: number;

  @Column({ type: 'text', array: true, default: '{}' })
  cuisines: string[];

  @Column({ type: 'decimal', precision: 8, scale: 2, default: 200 })
  price_per_session: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  rating: number;

  @Column({ type: 'int', default: 0 })
  total_reviews: number;

  @Column({ type: 'int', default: 0 })
  total_bookings: number;

  @Column({ default: true })
  is_available: boolean;

  @Column({ default: false })
  is_verified: boolean;

  @Column({ default: false })
  is_veg_only: boolean;

  // ─── SERVICE ROLE ─────────────────────────────────────
  @Column({
    type: 'simple-array',
    default: 'home_cook',
  })
  service_roles: string[];

  // ─── AVAILABILITY SETTINGS (Apr 24, 2026) ─────────────
  // How many minutes in advance a customer must book.
  // Default 60 min (1 hour) per launch decision.
  @Column({ type: 'int', default: 60 })
  min_advance_notice_minutes: number;

  // Gap required between back-to-back bookings for travel/setup.
  // Default 30 min. Prevents chef burnout + handles traffic delays.
  @Column({ type: 'int', default: 30 })
  booking_buffer_minutes: number;

  // ─── VERIFICATION DOCUMENTS ──────────────────────────
  @Column({ nullable: true })
  aadhaar_url: string;

  @Column({ nullable: true })
  pan_url: string;

  @Column({ nullable: true })
  address_proof_url: string;

  @Column({ nullable: true })
  fssai_url: string;

  // ─── EMERGENCY CONTACT ───────────────────────────────
  @Column({ type: 'varchar', length: 100, nullable: true })
  emergency_contact_name: string;

  @Column({ type: 'varchar', length: 15, nullable: true })
  emergency_contact_phone: string;

  // ─── VERIFICATION STATUS ─────────────────────────────
  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.NOT_SUBMITTED,
  })
  verification_status: VerificationStatus;

  @Column({ type: 'text', nullable: true })
  verification_rejection_reason: string;

  @Column({ type: 'timestamptz', nullable: true })
  verified_at: Date;

  // ─── BANK DETAILS ────────────────────────────────────
  @Column({ nullable: true })
  bank_account_number: string;

  @Column({ nullable: true })
  bank_ifsc: string;

  @Column({ nullable: true })
  bank_name: string;

  @Column({ nullable: true })
  razorpay_contact_id: string;

  @Column({ nullable: true })
  razorpay_fund_account_id: string;

  // ─── TERMS ACCEPTANCE ────────────────────────────────
  @Column({ default: false })
  terms_accepted: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  terms_accepted_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
