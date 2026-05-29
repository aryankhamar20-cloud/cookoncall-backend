import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Round 3 — admin push-notification broadcast log.
 *
 * One row per broadcast send. Stores the request payload (so a future
 * "resend" button can re-fan-out) and the delivery counters returned by
 * FCM. The admin UI lists the last 50 broadcasts so the team can see
 * what went out and when.
 */
export enum BroadcastAudience {
  ALL = 'all',
  CUSTOMERS = 'customers',
  COOKS = 'cooks',
  AREA = 'area',
}

@Entity('notification_broadcasts')
@Index('idx_notification_broadcasts_created', ['created_at'])
export class NotificationBroadcast {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 120 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'enum', enum: BroadcastAudience })
  audience: BroadcastAudience;

  /** When audience='area', this is the area slug filter. Null otherwise. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  area_slug: string | null;

  /** Optional deep link path opened on tap, e.g. `/promos/diwali`. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  deep_link: string | null;

  @Column({ type: 'uuid', nullable: true })
  sent_by_admin_id: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sent_by_admin_name: string | null;

  /** Number of users matched by the audience filter. */
  @Column({ type: 'int', default: 0 })
  recipients_targeted: number;

  /** Of those, how many had an FCM token registered. */
  @Column({ type: 'int', default: 0 })
  recipients_with_token: number;

  /** Whether FCM was actually called (false if no tokens or no FCM key). */
  @Column({ type: 'boolean', default: false })
  fcm_dispatched: boolean;

  /** In-app notifications written to the notifications table. */
  @Column({ type: 'int', default: 0 })
  inapp_created: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
