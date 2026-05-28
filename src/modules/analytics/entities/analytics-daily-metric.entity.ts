import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Pre-computed daily roll-ups. One row per (date, metric, optional
 * dimension). Refreshed by `AnalyticsAggregatorService`'s hourly cron
 * for "today" and once at midnight for "yesterday".
 *
 * Why pre-aggregate? Scanning `analytics_events` for every dashboard
 * load would take seconds even at 100k rows. With this rollup table
 * the dashboard loads sub-100ms regardless of total event count.
 *
 * `dimension_key` / `dimension_value` keep the schema flexible:
 *   - metric_type='bookings_total', dimension_key=NULL              → daily total
 *   - metric_type='bookings_by_city', dimension_key='city',
 *     dimension_value='Ahmedabad'                                   → daily Ahmedabad bookings
 *   - metric_type='revenue_by_cuisine', dimension_key='cuisine',
 *     dimension_value='gujarati'                                    → daily Gujarati revenue
 *
 * The unique constraint makes upserts trivial via TypeORM's `upsert()`.
 */
@Entity('analytics_daily_metrics')
@Unique('uq_metrics_date_type_dim', [
  'metric_date',
  'metric_type',
  'dimension_key',
  'dimension_value',
])
@Index('idx_metrics_date_type', ['metric_date', 'metric_type'])
@Index('idx_metrics_type_date', ['metric_type', 'metric_date'])
export class AnalyticsDailyMetric {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'date' })
  metric_date: string; // 'YYYY-MM-DD'

  @Column({ type: 'varchar', length: 64 })
  metric_type: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  dimension_key: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  dimension_value: string | null;

  @Column({ type: 'bigint', default: 0 })
  value_int: string; // bigint comes through as string in TypeORM

  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  value_decimal: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'computed_at' })
  computed_at: Date;
}
