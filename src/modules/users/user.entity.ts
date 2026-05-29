import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  OneToMany,
} from 'typeorm';
import { Exclude } from 'class-transformer';

export enum UserRole {
  USER = 'user',
  COOK = 'cook',
  ADMIN = 'admin',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100 })
  name: string;

  @Column({ unique: true, length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 15, nullable: true })
  phone: string | null;

  @Column({ default: false })
  phone_verified: boolean;

  @Column({ default: false })
  email_verified: boolean;

  @Exclude()
  @Column({ type: 'varchar', nullable: true })
  password: string | null;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Column({ type: 'varchar', nullable: true })
  avatar: string | null;

  @Column({ type: 'varchar', nullable: true })
  google_id: string | null;

  // ─── ADDRESS & GEOLOCATION ─────────────────────────────
  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude: number | null;

  @Exclude()
  @Column({ type: 'varchar', nullable: true })
  refresh_token: string | null;

  @Exclude()
  @Column({ type: 'varchar', nullable: true, length: 6 })
  otp: string | null;

  @Exclude()
  @Column({ type: 'timestamptz', nullable: true })
  otp_expires_at: Date | null;

  @Column({ default: true })
  is_active: boolean;

  // FCM push notification token (updated by Flutter app on login/launch)
  @Column({ nullable: true, type: 'text' })
  fcm_token: string | null;

  // ─── NOTIFICATION PREFERENCES (Round 4) ─────────────────
  // Customers and chefs can mute individual channels from Settings.
  // We default everything to ON because for a transactional service
  // (booking confirmations, payment receipts) the user expects
  // notifications until they opt out.
  //
  // The notifications service reads these flags before queuing email
  // or SMS; in-app notifications are NEVER suppressed (the user has
  // to be able to see their booking status when they open the app).
  @Column({ default: true })
  push_enabled: boolean;

  @Column({ default: true })
  email_enabled: boolean;

  @Column({ default: true })
  sms_enabled: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
