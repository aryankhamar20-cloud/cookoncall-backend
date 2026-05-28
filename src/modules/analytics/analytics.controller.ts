import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto, TrackEventDto } from './dto/analytics.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User, UserRole } from '../users/user.entity';

/**
 * Lightweight UA → device-type heuristic. Good enough for analytics
 * cohort splits without pulling in the 200kb 'ua-parser-js'.
 */
function classifyDevice(ua: string | undefined): string | null {
  if (!ua) return null;
  const lower = ua.toLowerCase();
  if (/(ipad|tablet)/.test(lower)) return 'tablet';
  if (/(android|iphone|mobile)/.test(lower)) return 'mobile';
  if (/dart\/|cookoncall\/|flutter/.test(lower)) return 'app';
  return 'desktop';
}

/**
 * /admin/analytics — ALL endpoints require role=admin.
 *
 * Each endpoint returns JSON shaped for direct consumption by Recharts
 * components on the web admin panel. No data is shaped twice.
 */
@Controller('admin/analytics')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@Query() dto: AnalyticsQueryDto) {
    return this.analytics.overview(dto);
  }

  @Get('users')
  users(@Query() dto: AnalyticsQueryDto) {
    return this.analytics.users(dto);
  }

  @Get('bookings')
  bookings(@Query() dto: AnalyticsQueryDto) {
    return this.analytics.bookings(dto);
  }

  @Get('revenue')
  revenue(@Query() dto: AnalyticsQueryDto) {
    return this.analytics.revenue(dto);
  }

  @Get('chefs')
  chefs(@Query() dto: AnalyticsQueryDto) {
    return this.analytics.chefs(dto);
  }

  @Get('locations')
  locations(@Query() dto: AnalyticsQueryDto) {
    return this.analytics.locations(dto);
  }

  /**
   * GET /admin/analytics/export.csv?metric=bookings|revenue|users|top_chefs
   * Streams CSV with proper download headers — no JSON wrapper from
   * the global TransformInterceptor (we'd write a special Bypass marker
   * but for now we let it fall through unwrapped via res.send).
   */
  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(
    @Query('metric') metric: string,
    @Query() dto: AnalyticsQueryDto,
    @Res() res: Response,
  ) {
    const csv = await this.analytics.exportCsv(metric ?? 'bookings', dto);
    res.set(
      'Content-Disposition',
      `attachment; filename="analytics-${metric}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`,
    );
    res.send(csv);
  }
}

/**
 * /events — public ingestion endpoint for client-side tracking
 * (page views, button clicks, etc.).
 *
 * Auth is OPTIONAL: when a JWT is present we backfill user_id / role,
 * but anonymous events are accepted as well — that's how we measure
 * pre-signup conversion funnels.
 */
@Controller('events')
export class EventsIngestionController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Public()
  @Post()
  async track(
    @Body() dto: TrackEventDto,
    @Req() req: Request,
    @CurrentUser() user?: User,
  ) {
    // Best-effort IP extraction (Cloudflare → Railway adds X-Forwarded-For)
    const ip =
      (req.headers['cf-connecting-ip'] as string) ||
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      null;

    await this.analytics.track({
      event_type: dto.event_type,
      user_id: user?.id ?? null,
      user_role: user?.role ?? null,
      session_id: dto.session_id ?? null,
      page_path: dto.page_path ?? null,
      referrer: dto.referrer ?? null,
      metadata: dto.metadata ?? null,
      ip_address: ip,
      user_agent: req.headers['user-agent'] ?? null,
      device_type: classifyDevice(req.headers['user-agent']),
    });
    return { ok: true };
  }
}
