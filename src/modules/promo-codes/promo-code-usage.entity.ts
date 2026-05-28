import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { PromoCode } from './promo-code.entity';
import { User } from '../users/user.entity';

/**
 * Tracks per-user promo code usage.
 * Prevents duplicate use by checking (promo_code_id, user_id).
 */
@Entity('promo_code_usages')
@Index(['promo_code_id', 'user_id'])
export class PromoCodeUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  promo_code_id: string;

  @ManyToOne(() => PromoCode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'promo_code_id' })
  promo_code: PromoCode;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // The booking this code was used on
  @Column({ type: 'uuid', nullable: true })
  booking_id: string;

  // Discount amount that was applied
  @Column({ type: 'decimal', precision: 8, scale: 2 })
  discount_amount: number;

  @CreateDateColumn({ type: 'timestamptz' })
  used_at: Date;
}
