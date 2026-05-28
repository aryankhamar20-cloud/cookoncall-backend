import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PromoType {
  PERCENTAGE  = 'percentage',   // e.g. 20% off
  FLAT        = 'flat',         // e.g. ₹100 off
  FREE_VISIT  = 'free_visit',   // waive the visit fee
}

@Entity('promo_codes')
export class PromoCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 20 })
  code: string;               // e.g. "WELCOME20"

  @Column({ type: 'enum', enum: PromoType })
  type: PromoType;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  value: number;              // % for PERCENTAGE, ₹ amount for FLAT

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  max_discount: number;       // cap for PERCENTAGE (e.g. max ₹200)

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  min_order_amount: number;   // minimum subtotal to apply promo

  @Column({ default: true })
  is_active: boolean;

  @Column({ default: false })
  single_use: boolean;        // if true, can only be used once per user

  @Column({ nullable: true })
  max_uses: number;           // global usage cap (null = unlimited)

  @Column({ default: 0 })
  used_count: number;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date;

  @Column({ type: 'text', nullable: true })
  description: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
