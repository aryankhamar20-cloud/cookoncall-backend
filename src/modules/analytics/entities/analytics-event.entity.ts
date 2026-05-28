import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Append-only event log. One row per tracked user action.
 *
 * Why bigint id? We expect this table to grow into the millions /
 * billions over the platform's life — UUIDs would balloon the index
 * size without buying us anything (events are never referenced by id
 * from elsewhere in the schema).
 *
 * Reads are dominated by:
 *   - the aggregator cron, scanning the previous day by event_type
 *   - admin ad-hoc queries scoped to a (user_id, time-range) tuple
 *
 * Both are covered by the composite indexes declared in the SQL
 * migration (`migrations/2026_05_28_analytics_phase1.sql`). We keep
 * the index annotations here too so a fresh `synchronize: true` dev
 * environment ends up with the same shape.
 */
@Entity('analytics_events')
@Index('idx_analytics_events_type_created', ['event_type', 'created_at'])
@Index('idx_analytics_events_user_created', ['user_id', 'created_at'])
@Index('idx_analytics_events_created', ['created_at'])
export class AnalyticsEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 64 })
  event_type: string;

  @Column({ type: 'uuid', nullable: true })
  user_id: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  user_role: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  session_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  page_path: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  referrer: string | null;

  /** Flexible bag for event-specific context (booking_id, amount, source, …). */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip_address: string | null;

  @Column({ type: 'text', nullable: true })
  user_agent: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  city: string | null;

  /** 'mobile' | 'desktop' | 'tablet' | 'app' — derived from UA on the server. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  device_type: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
