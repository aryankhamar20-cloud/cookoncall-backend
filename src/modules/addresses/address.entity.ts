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
import { User } from '../users/user.entity';

export enum AddressLabel {
  HOME = 'home',
  WORK = 'work',
  OTHER = 'other',
}

@Entity('addresses')
export class Address {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({
    type: 'enum',
    enum: AddressLabel,
    default: AddressLabel.HOME,
  })
  label: AddressLabel;

  @Column({ length: 100, nullable: true })
  contact_name: string;

  @Column({ length: 15, nullable: true })
  contact_phone: string;

  @Column({ length: 100 })
  house_no: string;

  @Column({ length: 200 })
  street: string;

  @Column({ length: 100, nullable: true })
  landmark: string;

  @Column({ length: 100 })
  area: string;

  // P1.6 — Optional slug from service_areas table. Set by frontend
  // when customer picks from dropdown; null when customer typed 'Other'.
  @Column({ type: 'varchar', length: 50, nullable: true })
  area_slug: string | null;

  @Column({ length: 100 })
  city: string;

  @Column({ length: 100 })
  state: string;

  @Column({ length: 10 })
  pincode: string;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude: number;

  @Column({ default: false })
  is_default: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
