import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsEvent } from './entities/analytics-event.entity';
import { AnalyticsDailyMetric } from './entities/analytics-daily-metric.entity';
import { AnalyticsService } from './analytics.service';
import {
  AdminAnalyticsController,
  EventsIngestionController,
} from './analytics.controller';
import { AnalyticsAggregatorService } from './analytics-aggregator.service';
import { AnalyticsRealtimeService } from './analytics-realtime.service';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AnalyticsEvent, AnalyticsDailyMetric]),
    // Round 4 — realtime service emits to admin sockets via the
    // gateway. EventsModule already exports the gateway provider.
    EventsModule,
  ],
  controllers: [AdminAnalyticsController, EventsIngestionController],
  providers: [
    AnalyticsService,
    AnalyticsAggregatorService,
    AnalyticsRealtimeService,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
