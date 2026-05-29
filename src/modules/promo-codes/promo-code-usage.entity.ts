import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { PromoCode } from './promo-code.entity';

@Entity('promo_code_usages')
@Unique(['promo_code_id', 'user_id'])   // one use per user for single_use promos
export class PromoCodeUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  promo_code_id: string;

  @Column()
  user_id: string;

  @Column({ type: 'varchar', nullable: true })
  booking_id: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  discount_applied: number;

  @CreateDateColumn({ type: 'timestamptz' })
  used_at: Date;

  @ManyToOne(() => PromoCode, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'promo_code_id' })
  promo_code: PromoCode;
}
