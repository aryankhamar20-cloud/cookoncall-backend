import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { AnalyticsDailyMetric } from './entities/analytics-daily-metric.entity';
import { AnalyticsQueryDto, AnalyticsRange } from './dto/analytics.dto';

/**
 * Resolves a [from, to] pair from a range enum + optional custom dates.
 * `to` is exclusive (today's events still rolling in), `from` inclusive.
 */
export function resolveRange(dto: AnalyticsQueryDto): { from: Date; to: Date; days: number } {
  const to = new Date();
  to.setHours(23, 59, 59, 999);
  let from = new Date(to);

  switch (dto.range) {
    case AnalyticsRange.LAST_24H:
      from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
      break;
    case AnalyticsRange.LAST_7D:
      from.setDate(from.getDate() - 6);
      break;
    case AnalyticsRange.LAST_30D:
      from.setDate(from.getDate() - 29);
      break;
    case AnalyticsRange.LAST_90D:
      from.setDate(from.getDate() - 89);
      break;
    case AnalyticsRange.CUSTOM:
      if (dto.from) from = new Date(dto.from);
      if (dto.to) to.setTime(new Date(dto.to).getTime());
      break;
    default:
      from.setDate(from.getDate() - 29); // default = 30d
  }
  from.setHours(0, 0, 0, 0);
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
  return { from, to, days };
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(AnalyticsEvent)
    private readonly eventsRepo: Repository<AnalyticsEvent>,
    @InjectRepository(AnalyticsDailyMetric)
    private readonly metricsRepo: Repository<AnalyticsDailyMetric>,
    private readonly dataSource: DataSource,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // EVENT INGESTION
  // ═══════════════════════════════════════════════════════════════

  async track(payload: Partial<AnalyticsEvent>): Promise<void> {
    try {
      // Insert directly via raw query to bypass any subscriber overhead —
      // the events table is hot-path so we want this as cheap as possible.
      await this.eventsRepo.insert({
        event_type: payload.event_type ?? 'unknown',
        user_id: payload.user_id ?? null,
        user_role: payload.user_role ?? null,
        session_id: payload.session_id ?? null,
        page_path: payload.page_path ?? null,
        referrer: payload.referrer ?? null,
        metadata: payload.metadata ?? null,
        ip_address: payload.ip_address ?? null,
        user_agent: payload.user_agent ?? null,
        city: payload.city ?? null,
        device_type: payload.device_type ?? null,
      });
    } catch (err) {
      // Never let a failed analytics insert break the user-facing request.
      this.logger.warn(`track() failed: ${(err as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // OVERVIEW — single endpoint with the headline KPIs
  // ═══════════════════════════════════════════════════════════════

  async overview(dto: AnalyticsQueryDto) {
    const { from, to, days } = resolveRange(dto);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    // Run all queries in parallel — they're all read-only against
    // independent tables. Total wall-clock time = max(individual time)
    // instead of sum.
    const [
      userTotals,
      newUsers,
      bookingTotals,
      revenueTotals,
      cookTotals,
      dau,
    ] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE is_active = true) AS active
         FROM users`,
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS new_users
         FROM users
         WHERE created_at >= $1 AND created_at <= $2`,
        [fromIso, toIso],
      ),
      this.dataSource.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'completed') AS completed,
           COUNT(*) FILTER (WHERE status IN ('cancelled_by_user','cancelled_by_cook','expired')) AS cancelled,
           COUNT(*) FILTER (WHERE status IN ('pending_chef_approval','awaiting_payment','confirmed','in_progress','pending')) AS active
         FROM bookings
         WHERE created_at >= $1 AND created_at <= $2`,
        [fromIso, toIso],
      ),
      this.dataSource.query(
        `SELECT
           COALESCE(SUM(total_price), 0) AS gmv,
           COALESCE(SUM(total_price) FILTER (WHERE status = 'completed'), 0) AS gross_revenue,
           COALESCE(AVG(total_price) FILTER (WHERE status = 'completed'), 0) AS aov
         FROM bookings
         WHERE created_at >= $1 AND created_at <= $2`,
        [fromIso, toIso],
      ),
      this.dataSource.query(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE is_verified = true) AS verified,
           COUNT(*) FILTER (WHERE is_available = true AND is_verified = true) AS active_now
         FROM cooks`,
      ),
      // DAU = unique users with any login event today.
      // Falls back to 0 if no events have been tracked yet.
      this.dataSource.query(
        `SELECT COUNT(DISTINCT user_id) AS dau
         FROM analytics_events
         WHERE event_type IN ('login','session_start','page_view')
           AND created_at >= NOW() - INTERVAL '24 hours'
           AND user_id IS NOT NULL`,
      ),
    ]);

    const total = Number(bookingTotals[0]?.total ?? 0);
    const cancelled = Number(bookingTotals[0]?.cancelled ?? 0);
    const cancelRate = total > 0 ? (cancelled / total) * 100 : 0;

    // Backend takes 2.5% platform commission on completed bookings
    const grossRevenue = Number(revenueTotals[0]?.gross_revenue ?? 0);
    const platformCommission = +(grossRevenue * 0.025).toFixed(2);
    const chefPayouts = +(grossRevenue - platformCommission).toFixed(2);

    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), days },
      users: {
        total: Number(userTotals[0]?.total ?? 0),
        active: Number(userTotals[0]?.active ?? 0),
        new_in_range: Number(newUsers[0]?.new_users ?? 0),
        dau: Number(dau[0]?.dau ?? 0),
      },
      cooks: {
        total: Number(cookTotals[0]?.total ?? 0),
        verified: Number(cookTotals[0]?.verified ?? 0),
        active_now: Number(cookTotals[0]?.active_now ?? 0),
      },
      bookings: {
        total,
        completed: Number(bookingTotals[0]?.completed ?? 0),
        cancelled,
        active: Number(bookingTotals[0]?.active ?? 0),
        cancel_rate_percent: +cancelRate.toFixed(2),
      },
      revenue: {
        gmv: +Number(revenueTotals[0]?.gmv ?? 0).toFixed(2),
        gross_revenue: grossRevenue,
        platform_commission: platformCommission,
        chef_payouts: chefPayouts,
        avg_order_value: +Number(revenueTotals[0]?.aov ?? 0).toFixed(2),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // USERS — signups + DAU/MAU + breakdowns
  // ═══════════════════════════════════════════════════════════════

  async users(dto: AnalyticsQueryDto) {
    const { from, to } = resolveRange(dto);
    const [signups, byRole, byDevice] = await Promise.all([
      this.dataSource.query(
        `SELECT DATE(created_at) AS date, COUNT(*)::int AS count
         FROM users
         WHERE created_at >= $1 AND created_at <= $2
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
        [from.toISOString(), to.toISOString()],
      ),
      this.dataSource.query(
        `SELECT role, COUNT(*)::int AS count
         FROM users
         GROUP BY role`,
      ),
      this.dataSource.query(
        `SELECT COALESCE(device_type, 'unknown') AS device, COUNT(DISTINCT user_id)::int AS count
         FROM analytics_events
         WHERE created_at >= $1 AND user_id IS NOT NULL
         GROUP BY device_type`,
        [from.toISOString()],
      ),
    ]);
    return {
      signups,
      by_role: byRole,
      by_device: byDevice,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOKINGS — daily series + status breakdown + peak hours
  // ═══════════════════════════════════════════════════════════════

  async bookings(dto: AnalyticsQueryDto) {
    const { from, to } = resolveRange(dto);
    const [daily, byStatus, peakHours] = await Promise.all([
      this.dataSource.query(
        `SELECT DATE(created_at) AS date,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE status IN ('cancelled_by_user','cancelled_by_cook','expired'))::int AS cancelled,
                COALESCE(SUM(total_price), 0)::numeric AS gmv
         FROM bookings
         WHERE created_at >= $1 AND created_at <= $2
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
        [from.toISOString(), to.toISOString()],
      ),
      this.dataSource.query(
        `SELECT status, COUNT(*)::int AS count
         FROM bookings
         WHERE created_at >= $1 AND created_at <= $2
         GROUP BY status
         ORDER BY count DESC`,
        [from.toISOString(), to.toISOString()],
      ),
      // Peak booking hours of day (0-23) over the window
      this.dataSource.query(
        `SELECT EXTRACT(HOUR FROM scheduled_at)::int AS hour,
                COUNT(*)::int AS count
         FROM bookings
         WHERE created_at >= $1 AND created_at <= $2
         GROUP BY hour
         ORDER BY hour ASC`,
        [from.toISOString(), to.toISOString()],
      ),
    ]);
    return { daily, by_status: byStatus, peak_hours: peakHours };
  }

  // ═══════════════════════════════════════════════════════════════
  // REVENUE — daily GMV/commission/payout split
  // ═══════════════════════════════════════════════════════════════

  async revenue(dto: AnalyticsQueryDto) {
    const { from, to } = resolveRange(dto);
    const [daily, topCities] = await Promise.all([
      this.dataSource.query(
        `SELECT DATE(created_at) AS date,
                COALESCE(SUM(total_price), 0)::numeric AS gmv,
                COALESCE(SUM(total_price) FILTER (WHERE status = 'completed'), 0)::numeric AS gross_revenue,
                COALESCE(AVG(total_price) FILTER (WHERE status = 'completed'), 0)::numeric AS aov,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count
         FROM bookings
         WHERE created_at >= $1 AND created_at <= $2
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
        [from.toISOString(), to.toISOString()],
      ),
      // Top cities by completed-booking GMV — joins via cook → user → address
      this.dataSource.query(
        `SELECT COALESCE(c.city, 'Unknown') AS city,
                COUNT(*)::int AS bookings,
                COALESCE(SUM(b.total_price), 0)::numeric AS revenue
         FROM bookings b
         LEFT JOIN cooks c ON c.id = b.cook_id
         WHERE b.created_at >= $1 AND b.created_at <= $2
           AND b.status = 'completed'
         GROUP BY c.city
         ORDER BY revenue DESC
         LIMIT 10`,
        [from.toISOString(), to.toISOString()],
      ),
    ]);
    // Add commission split on each daily row
    const dailyWithCommission = daily.map((d: any) => {
      const gross = Number(d.gross_revenue);
      const commission = +(gross * 0.025).toFixed(2);
      return {
        ...d,
        platform_commission: commission,
        chef_payout: +(gross - commission).toFixed(2),
      };
    });
    return { daily: dailyWithCommission, by_city: topCities };
  }

  // ═══════════════════════════════════════════════════════════════
  // CHEFS — top performers, acceptance/completion rates
  // ═══════════════════════════════════════════════════════════════

  async chefs(dto: AnalyticsQueryDto) {
    const { from, to } = resolveRange(dto);
    const [topByBookings, topByRevenue, topByRating, ratesQuery] =
      await Promise.all([
        this.dataSource.query(
          `SELECT c.id, u.name, u.avatar, c.rating::numeric, c.total_bookings::int,
                  COUNT(b.id)::int AS bookings_in_range
           FROM cooks c
           JOIN users u ON u.id = c.user_id
           LEFT JOIN bookings b ON b.cook_id = c.id
             AND b.created_at >= $1 AND b.created_at <= $2
           GROUP BY c.id, u.name, u.avatar
           ORDER BY bookings_in_range DESC, c.total_bookings DESC
           LIMIT 10`,
          [from.toISOString(), to.toISOString()],
        ),
        this.dataSource.query(
          `SELECT c.id, u.name, u.avatar,
                  COALESCE(SUM(b.total_price) FILTER (WHERE b.status = 'completed'), 0)::numeric AS revenue,
                  COUNT(b.id) FILTER (WHERE b.status = 'completed')::int AS completed
           FROM cooks c
           JOIN users u ON u.id = c.user_id
           LEFT JOIN bookings b ON b.cook_id = c.id
             AND b.created_at >= $1 AND b.created_at <= $2
           GROUP BY c.id, u.name, u.avatar
           HAVING COALESCE(SUM(b.total_price) FILTER (WHERE b.status = 'completed'), 0) > 0
           ORDER BY revenue DESC
           LIMIT 10`,
          [from.toISOString(), to.toISOString()],
        ),
        this.dataSource.query(
          `SELECT c.id, u.name, u.avatar, c.rating::numeric, c.total_reviews::int
           FROM cooks c
           JOIN users u ON u.id = c.user_id
           WHERE c.total_reviews >= 5
           ORDER BY c.rating DESC, c.total_reviews DESC
           LIMIT 10`,
        ),
        this.dataSource.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'cancelled_by_cook')::int AS rejected,
             COUNT(*) FILTER (WHERE status NOT IN ('pending_chef_approval'))::int AS responded,
             COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
             COUNT(*)::int AS total
           FROM bookings
           WHERE created_at >= $1 AND created_at <= $2`,
          [from.toISOString(), to.toISOString()],
        ),
      ]);
    const r = ratesQuery[0] ?? {};
    const total = Number(r.total ?? 0);
    return {
      top_by_bookings: topByBookings,
      top_by_revenue: topByRevenue,
      top_by_rating: topByRating,
      rates: {
        acceptance_rate_percent:
          total > 0 ? +(((total - Number(r.rejected ?? 0)) / total) * 100).toFixed(2) : 0,
        completion_rate_percent:
          total > 0 ? +((Number(r.completed ?? 0) / total) * 100).toFixed(2) : 0,
        rejection_rate_percent:
          total > 0 ? +((Number(r.rejected ?? 0) / total) * 100).toFixed(2) : 0,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // LOCATIONS — by city + by chef service area
  // ═══════════════════════════════════════════════════════════════

  async locations(dto: AnalyticsQueryDto) {
    const { from, to } = resolveRange(dto);
    const [byCity, chefDensity] = await Promise.all([
      this.dataSource.query(
        `SELECT COALESCE(c.city, 'Unknown') AS city,
                COUNT(b.id)::int AS bookings,
                COALESCE(SUM(b.total_price) FILTER (WHERE b.status = 'completed'), 0)::numeric AS revenue
         FROM bookings b
         LEFT JOIN cooks c ON c.id = b.cook_id
         WHERE b.created_at >= $1 AND b.created_at <= $2
         GROUP BY c.city
         ORDER BY bookings DESC
         LIMIT 20`,
        [from.toISOString(), to.toISOString()],
      ),
      this.dataSource.query(
        `SELECT COALESCE(c.city, 'Unknown') AS city,
                COUNT(*)::int AS chef_count,
                COUNT(*) FILTER (WHERE c.is_verified = true)::int AS verified_count
         FROM cooks c
         GROUP BY c.city
         ORDER BY chef_count DESC
         LIMIT 20`,
      ),
    ]);
    return { by_city: byCity, chef_density: chefDensity };
  }

  // ═══════════════════════════════════════════════════════════════
  // CSV EXPORT — generic dispatcher: any of the metric streams above
  // ═══════════════════════════════════════════════════════════════

  async exportCsv(metric: string, dto: AnalyticsQueryDto): Promise<string> {
    const cleanMetric = metric.replace(/[^a-z_]/gi, '');
    let rows: Record<string, unknown>[] = [];
    switch (cleanMetric) {
      case 'bookings':
        rows = (await this.bookings(dto)).daily;
        break;
      case 'revenue':
        rows = (await this.revenue(dto)).daily;
        break;
      case 'users':
        rows = (await this.users(dto)).signups;
        break;
      case 'top_chefs':
        rows = (await this.chefs(dto)).top_by_revenue;
        break;
      default:
        throw new Error(`Unknown metric: ${metric}`);
    }
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push(
        headers
          .map((h) => {
            const v = r[h];
            if (v === null || v === undefined) return '';
            const str = String(v).replace(/"/g, '""');
            return /[,"\n]/.test(str) ? `"${str}"` : str;
          })
          .join(','),
      );
    }
    return lines.join('\n');
  }
}
