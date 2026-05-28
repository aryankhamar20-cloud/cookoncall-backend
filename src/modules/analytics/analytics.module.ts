import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { AnalyticsDailyMetric } from './entities/analytics-daily-metric.entity';
import { User } from '../users/user.entity';
import { AnalyticsService } from './analytics.service';
import {
  AdminAnalyticsController,
  EventsIngestionController,
} from './analytics.controller';
import { AnalyticsAggregatorService } from './analytics-aggregator.service';
import { AnalyticsRealtimeService } from './analytics-realtime.service';
import { AnalyticsPdfService } from './analytics-pdf.service';
import { AnalyticsDigestService } from './analytics-digest.service';
import { EventsModule } from '../events/events.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    // We register User locally so the digest service can pull active
    // admins without taking a dep on UsersModule (which itself imports
    // AnalyticsModule via a few transitive chains — forwardRef-safer).
    TypeOrmModule.forFeature([AnalyticsEvent, AnalyticsDailyMetric, User]),
    // Round 4 — realtime service emits to admin sockets via the
    // gateway. EventsModule already exports the gateway provider.
    EventsModule,
    // Phase 3 — digest service uses NotificationsService.sendDirectEmail.
    // forwardRef avoids the NotificationsModule -> AnalyticsModule
    // (recordClick) cycle.
    forwardRef(() => NotificationsModule),
  ],
  controllers: [AdminAnalyticsController, EventsIngestionController],
  providers: [
    AnalyticsService,
    AnalyticsAggregatorService,
    AnalyticsRealtimeService,
    AnalyticsPdfService,
    AnalyticsDigestService,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
