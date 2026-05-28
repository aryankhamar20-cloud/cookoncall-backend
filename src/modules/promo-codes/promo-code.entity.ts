import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum PromoType {
  FLAT = 'flat',         // ₹50 off
  PERCENT = 'percent',   // 10% off (capped by max_discount)
}

/**
 * Promo code that customers can apply at checkout.
 * Flat discount or percentage discount with optional cap.
 */
@Entity('promo_codes')
export class PromoCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 30 })
  code: string;

  @Column({ type: 'enum', enum: PromoType, default: PromoType.FLAT })
  type: PromoType;

  // Amount: for FLAT = ₹ amount; for PERCENT = percentage (e.g. 10 = 10%)
  @Column({ type: 'decimal', precision: 8, scale: 2 })
  value: number;

  // Minimum order amount to apply this code
  @Column({ type: 'decimal', precision: 8, scale: 2, default: 0 })
  min_order: number;

  // Max discount cap (only for PERCENT type, null = no cap)
  @Column({ type: 'decimal', precision: 8, scale: 2, nullable: true })
  max_discount: number;

  // Total uses allowed (null = unlimited)
  @Column({ type: 'int', nullable: true })
  max_uses: number;

  // Per-user usage limit (null = unlimited per user, usually 1)
  @Column({ type: 'int', nullable: true, default: 1 })
  max_uses_per_user: number;

  // How many times this code has been used total
  @Column({ type: 'int', default: 0 })
  used_count: number;

  @Column({ type: 'timestamptz' })
  valid_from: Date;

  @Column({ type: 'timestamptz' })
  valid_until: Date;

  @Column({ default: true })
  is_active: boolean;

  // Optional: restrict to first booking only
  @Column({ default: false })
  first_booking_only: boolean;

  // Optional: human-readable description for admin UI
  @Column({ type: 'text', nullable: true })
  description: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
