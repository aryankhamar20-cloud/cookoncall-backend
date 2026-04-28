import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

@Entity('service_areas')
export class ServiceArea {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 50 })
  slug: string;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 50 })
  region: string; // 'west' | 'central' | 'north' | 'east'

  @Column({ length: 50, default: 'Ahmedabad' })
  city: string;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'int', default: 0 })
  sort_order: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

export type RequesterRole = 'cook' | 'customer';
export type AreaRequestStatus = 'pending' | 'approved' | 'rejected';

@Entity('area_requests')
export class AreaRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  requester_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requester_id' })
  requester: User;

  @Column({ length: 20 })
  requester_role: RequesterRole;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 50, default: 'Ahmedabad' })
  city: string;

  @Index()
  @Column({ length: 20, default: 'pending' })
  status: AreaRequestStatus;

  @Column({ length: 50, nullable: true })
  approved_slug: string | null;

  @Column({ type: 'text', nullable: true })
  reject_reason: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
