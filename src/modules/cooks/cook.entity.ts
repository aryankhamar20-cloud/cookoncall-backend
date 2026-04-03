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

  @Column({ nullable: true })
  aadhaar_url: string;

  @Column({ nullable: true })
  pan_url: string;

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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
