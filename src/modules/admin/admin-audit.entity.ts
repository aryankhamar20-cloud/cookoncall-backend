import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Immutable log of every destructive / sensitive admin action.
 * Never update rows — only INSERT. Used for accountability + debugging.
 */
@Entity('admin_audit_logs')
export class AdminAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Which admin performed the action (users.id)
  @Index()
  @Column({ type: 'uuid', nullable: true })
  admin_user_id: string;

  // Human-readable name at time of action (in case user is later deleted)
  @Column({ type: 'varchar', length: 200, nullable: true })
  admin_name: string;

  // Action name, e.g. 'cook.verify', 'cook.reject', 'user.delete',
  // 'user.toggle_active', 'user.update', 'cook.delete',
  // 'booking.update_status', 'booking.delete'
  @Index()
  @Column({ type: 'varchar', length: 80 })
  action: string;

  // What kind of entity was touched: 'user' | 'cook' | 'booking'
  @Column({ type: 'varchar', length: 40 })
  target_type: string;

  // The affected row's id
  @Index()
  @Column({ type: 'varchar', length: 80, nullable: true })
  target_id: string;

  // Free-form JSON: before/after values, reason, etc.
  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, any>;

  // Request IP (best-effort)
  @Column({ type: 'varchar', length: 64, nullable: true })
  ip_address: string;

  // Request user-agent (best-effort)
  @Column({ type: 'text', nullable: true })
  user_agent: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
