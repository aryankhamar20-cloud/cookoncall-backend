import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { AnalyticsDailyMetric } from './entities/analytics-daily-metric.entity';

/**
 * Hourly cron that refreshes today's roll-ups, plus a midnight job
 * that finalises yesterday so the previous day is frozen in stone.
 *
 * Why hourly + nightly instead of every-N-seconds?
 *   - Dashboards rarely need second-fresh numbers.
 *   - The aggregator scans the events table; running it constantly
 *     would compete with hot-path writes.
 *   - Keeping the cadence loose also keeps the table size predictable.
 *
 * Each refresh is a single multi-row UPSERT — idempotent and safe to
 * run again at any time.
 */
@Injectable()
export class AnalyticsAggregatorService {
  private readonly logger = new Logger(AnalyticsAggregatorService.name);

  constructor(
    @InjectRepository(AnalyticsDailyMetric)
    private readonly metricsRepo: Repository<AnalyticsDailyMetric>,
    private readonly dataSource: DataSource,
  ) {}

  // Top of every hour — refresh today's roll-ups
  @Cron(CronExpression.EVERY_HOUR)
  async refreshToday() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await this.aggregateForDate(today, 'hourly:today');
  }

  // 00:30 IST every night — finalise yesterday so dashboards looking at
  // "yesterday" see a frozen, complete number.
  @Cron('30 0 * * *')
  async finaliseYesterday() {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    y.setHours(0, 0, 0, 0);
    await this.aggregateForDate(y, 'nightly:yesterday');
  }

  private async aggregateForDate(date: Date, label: string) {
    const dateStr = date.toISOString().slice(0, 10);
    const start = `${dateStr} 00:00:00`;
    const end = `${dateStr} 23:59:59`;
    this.logger.log(`Aggregating ${dateStr} (${label})`);
    try {
      // Single multi-CTE query that computes 5 metrics in one round-trip
      // and upserts them. Keeps DB chatter to a minimum.
      await this.dataSource.query(
        `
        WITH new_users AS (
          SELECT COUNT(*)::bigint AS v
          FROM users
          WHERE created_at >= $1 AND created_at <= $2
        ),
        bookings_total AS (
          SELECT COUNT(*)::bigint AS v
          FROM bookings
          WHERE created_at >= $1 AND created_at <= $2
        ),
        bookings_completed AS (
          SELECT COUNT(*)::bigint AS v
          FROM bookings
          WHERE created_at >= $1 AND created_at <= $2 AND status = 'completed'
        ),
        gmv AS (
          SELECT COALESCE(SUM(total_price), 0)::numeric AS v
          FROM bookings
          WHERE created_at >= $1 AND created_at <= $2
        ),
        gross_revenue AS (
          SELECT COALESCE(SUM(total_price), 0)::numeric AS v
          FROM bookings
          WHERE created_at >= $1 AND created_at <= $2 AND status = 'completed'
        ),
        dau AS (
          SELECT COUNT(DISTINCT user_id)::bigint AS v
          FROM analytics_events
          WHERE created_at >= $1 AND created_at <= $2
            AND user_id IS NOT NULL
        )
        INSERT INTO analytics_daily_metrics
          (metric_date, metric_type, dimension_key, dimension_value, value_int, value_decimal)
        SELECT $3::date, 'new_users',         NULL, NULL, (SELECT v FROM new_users),         0 UNION ALL
        SELECT $3::date, 'bookings_total',    NULL, NULL, (SELECT v FROM bookings_total),    0 UNION ALL
        SELECT $3::date, 'bookings_completed',NULL, NULL, (SELECT v FROM bookings_completed),0 UNION ALL
        SELECT $3::date, 'gmv',               NULL, NULL, 0,                                 (SELECT v FROM gmv) UNION ALL
        SELECT $3::date, 'gross_revenue',     NULL, NULL, 0,                                 (SELECT v FROM gross_revenue) UNION ALL
        SELECT $3::date, 'dau',               NULL, NULL, (SELECT v FROM dau),               0
        ON CONFLICT (metric_date, metric_type, dimension_key, dimension_value)
        DO UPDATE SET
          value_int = EXCLUDED.value_int,
          value_decimal = EXCLUDED.value_decimal,
          computed_at = NOW();
        `,
        [start, end, dateStr],
      );
    } catch (err) {
      this.logger.error(
        `Aggregation for ${dateStr} failed: ${(err as Error).message}`,
      );
    }
  }
}
