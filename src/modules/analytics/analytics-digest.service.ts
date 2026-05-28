import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { User, UserRole } from '../users/user.entity';
import { AnalyticsService } from './analytics.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Analytics Phase 3 — Daily admin email digest.
 *
 * Sends an HTML "yesterday in CookOnCall" summary email to every
 * active admin every morning at 09:00 IST (03:30 UTC).
 *
 * Why bother?
 * ───────────
 * Admins already have the live dashboard, but the digest does two
 * things the dashboard can't:
 *   1. Reaches them where they live (inbox) without a context-switch.
 *   2. Anchors a "is yesterday's number better or worse than the day
 *      before?" comparison, which is impossible to read at-a-glance
 *      from a 7-day chart.
 *
 * Privacy / preferences
 * ─────────────────────
 * The Round 4 user-level `email_enabled` flag still applies — admins
 * who muted email don't get the digest. We don't bother surfacing a
 * separate "digest only" toggle: muting email entirely is a strong
 * enough signal.
 *
 * Failure mode
 * ────────────
 * Per-admin send failures are caught individually so one bad recipient
 * doesn't block the rest. Cron-level errors are logged and swallowed
 * to keep the scheduler worker alive.
 */
@Injectable()
export class AnalyticsDigestService {
  private readonly logger = new Logger(AnalyticsDigestService.name);
  private readonly digestEnabled: boolean;

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly analytics: AnalyticsService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    // Default ON in production; set ANALYTICS_DIGEST_DISABLED=true on
    // staging so we don't email real admins from a non-prod cron.
    this.digestEnabled = config.get('ANALYTICS_DIGEST_DISABLED') !== 'true';
  }

  /**
   * 03:30 UTC = 09:00 IST. Picked deliberately for the morning-coffee
   * window. Cron expression is "30 3 * * *" — minute hour dom month dow.
   */
  @Cron('30 3 * * *', { timeZone: 'UTC' })
  async runDailyDigest(): Promise<void> {
    if (!this.digestEnabled) {
      this.logger.log('Daily digest disabled via env — skipping.');
      return;
    }

    try {
      // Build the digest body once, reuse across all admins. The
      // numbers don't depend on the recipient.
      const digest = await this.buildYesterdayDigest();
      const html = this.renderHtml(digest);
      const subject = `CookOnCall · ${digest.dateLabel} · ${digest.bookings.completed} bookings, ${digest.revenue.netLabel}`;

      const admins = await this.usersRepo.find({
        where: { role: UserRole.ADMIN, is_active: true, email_enabled: true },
        select: ['id', 'name', 'email'] as any,
      });

      this.logger.log(
        `Daily digest: dispatching to ${admins.length} admin(s) for ${digest.dateLabel}.`,
      );

      let sent = 0;
      let failed = 0;
      for (const a of admins) {
        if (!a.email) continue;
        try {
          // sendDirectEmail is the synchronous Brevo HTTP API path
          // (Railway blocks SMTP, so we don't queue). Per-admin
          // try/catch stops a single bad address from blocking the
          // rest.
          await this.notifications.sendDirectEmail(a.email, subject, html);
          sent++;
        } catch (err: any) {
          failed++;
          this.logger.warn(
            `Digest send failed for ${a.email}: ${err?.message || err}`,
          );
        }
      }
      this.logger.log(`Daily digest done — sent=${sent} failed=${failed}`);
    } catch (err: any) {
      // Cron failures are silent in NestJS by default; surface them
      // without re-throwing (re-throwing crashes the scheduler).
      this.logger.error(`Daily digest crashed: ${err?.message || err}`);
    }
  }

  /**
   * Public for tests + the manual "preview my digest" admin endpoint.
   */
  async buildYesterdayDigest() {
    // "Yesterday" in IST. We freeze the date at midnight IST, then
    // shift to UTC so the analytics queries (which use UTC date_trunc)
    // don't double-bucket.
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    istNow.setUTCHours(0, 0, 0, 0);
    const yesterdayIst = new Date(istNow.getTime() - 24 * 60 * 60 * 1000);
    const beforeYesterdayIst = new Date(yesterdayIst.getTime() - 24 * 60 * 60 * 1000);

    // Convert back to UTC (the windows we hand to AnalyticsService).
    const yesterdayUtc = new Date(yesterdayIst.getTime() - istOffsetMs);
    const todayUtc = new Date(istNow.getTime() - istOffsetMs);
    const beforeYesterdayUtc = new Date(beforeYesterdayIst.getTime() - istOffsetMs);

    const [yesterday, dayBefore] = await Promise.all([
      this.analytics.overview({ from: yesterdayUtc.toISOString(), to: todayUtc.toISOString() }),
      this.analytics
        .overview({ from: beforeYesterdayUtc.toISOString(), to: yesterdayUtc.toISOString() })
        .catch(() => null), // tolerate first-day-of-app no-data
    ]);

    // Day-over-day deltas for the email's "is this better or worse?"
    // arrows. Falls back to 0 when day-before data is missing.
    const deltaPct = (cur: number, prev: number): number => {
      if (!prev) return 0;
      return Math.round(((cur - prev) / prev) * 100);
    };

    const cur = {
      bookings: {
        total: yesterday.bookings?.total ?? 0,
        completed: yesterday.bookings?.completed ?? 0,
        cancelled: yesterday.bookings?.cancelled ?? 0,
      },
      users: {
        new: yesterday.users?.new_in_range ?? 0,
        dau: yesterday.users?.dau ?? 0,
      },
      revenue: {
        // GMV = gross merchandise value (total customer payments).
        // Net = platform_commission (what CookOnCall keeps).
        gmv: yesterday.revenue?.gmv ?? yesterday.revenue?.gross_revenue ?? 0,
        net: yesterday.revenue?.platform_commission ?? 0,
      },
    };
    const prev = dayBefore && {
      bookings: { completed: dayBefore.bookings?.completed ?? 0 },
      users: { new: dayBefore.users?.new_in_range ?? 0 },
      revenue: { net: dayBefore.revenue?.platform_commission ?? 0 },
    };

    return {
      dateLabel: yesterdayIst.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
      bookings: cur.bookings,
      users: cur.users,
      revenue: {
        ...cur.revenue,
        netLabel: `\u20B9${Math.round(cur.revenue.net).toLocaleString('en-IN')}`,
      },
      deltas: prev
        ? {
            completed_bookings_pct: deltaPct(cur.bookings.completed, prev.bookings.completed),
            new_users_pct: deltaPct(cur.users.new, prev.users.new),
            net_revenue_pct: deltaPct(cur.revenue.net, prev.revenue.net),
          }
        : null,
    };
  }

  // ─── HTML render ────────────────────────────────────
  /**
   * Inline-styled HTML so it survives Gmail/Outlook rendering. Layout
   * mirrors the booking-receipt email (Round 2) for consistency:
   *   • Cream/orange header
   *   • Big number + small label tile pattern
   *   • Always-visible CTA back to the live dashboard
   */
  private renderHtml(d: Awaited<ReturnType<AnalyticsDigestService['buildYesterdayDigest']>>): string {
    const arrow = (n: number) => (n > 0 ? '\u2191' : n < 0 ? '\u2193' : '\u2192');
    const arrowColor = (n: number) =>
      n > 0 ? '#10b981' : n < 0 ? '#ef4444' : '#9ca3af';

    const deltaSpan = (label: string, n: number | undefined) => {
      if (n == null) return '';
      const sign = n > 0 ? '+' : '';
      return `<span style="color:${arrowColor(n)};font-size:12px;font-weight:600;margin-left:6px;">${arrow(n)} ${sign}${n}% ${label}</span>`;
    };

    const tile = (label: string, value: string, delta?: string) => `
      <td style="padding:0 6px;width:25%;">
        <div style="background:#FFF7ED;border:1px solid #F2D9B6;border-radius:8px;padding:14px;">
          <div style="color:#8B7355;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">${label}</div>
          <div style="color:#3D2418;font-size:22px;font-weight:800;margin-top:4px;">${value}</div>
          ${delta ?? ''}
        </div>
      </td>`;

    return `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#FAFAFA;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#FAFAFA;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #F2D9B6;">
        <tr>
          <td style="padding:28px 28px 18px 28px;background:linear-gradient(135deg,#D4721A 0%,#8B4513 100%);">
            <div style="color:#fff;font-size:14px;font-weight:600;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">CookOnCall · Daily digest</div>
            <div style="color:#fff;font-size:24px;font-weight:800;margin-top:4px;">${d.dateLabel}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 28px;">
            <div style="color:#5D4E37;font-size:14px;line-height:1.6;margin-bottom:18px;">
              Here's how yesterday went.
            </div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                ${tile('Bookings', String(d.bookings.total))}
                ${tile('Completed', String(d.bookings.completed), d.deltas ? deltaSpan('vs prev day', d.deltas.completed_bookings_pct) : '')}
                ${tile('New users', String(d.users.new), d.deltas ? deltaSpan('vs prev day', d.deltas.new_users_pct) : '')}
                ${tile('DAU', String(d.users.dau))}
              </tr>
              <tr><td colspan="4" style="padding:6px;"></td></tr>
              <tr>
                ${tile('Net revenue', d.revenue.netLabel, d.deltas ? deltaSpan('vs prev day', d.deltas.net_revenue_pct) : '')}
                ${tile('Cancelled', String(d.bookings.cancelled))}
                <td colspan="2" style="padding:0 6px;width:50%;">
                  <a href="https://thecookoncall.com/dashboard/admin?panel=analytics"
                     style="display:block;background:#D4721A;color:#fff;text-decoration:none;font-weight:700;text-align:center;padding:18px;border-radius:8px;font-size:14px;">
                    Open live dashboard \u2192
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 28px;border-top:1px solid #F2D9B6;color:#9CA3AF;font-size:11px;text-align:center;">
            You receive this digest because you're an admin on CookOnCall.<br>
            Mute it from <a style="color:#D4721A;" href="https://thecookoncall.com/dashboard/customer?panel=settings">Settings → Notifications → Email</a>.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  }
}
