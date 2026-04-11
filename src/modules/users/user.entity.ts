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

  @Column({ length: 15, nullable: true })
  phone: string;

  @Column({ default: false })
  phone_verified: boolean;

  @Column({ default: false })
  email_verified: boolean;

  @Exclude()
  @Column({ nullable: true })
  password: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Column({ nullable: true })
  avatar: string;

  @Column({ nullable: true })
  google_id: string;

  @Exclude()
  @Column({ nullable: true })
  refresh_token: string;

  @Exclude()
  @Column({ nullable: true, length: 6 })
  otp: string;

  @Exclude()
  @Column({ type: 'timestamptz', nullable: true })
  otp_expires_at: Date;

  @Column({ default: true })
  is_active: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
