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

@Module({
  imports: [TypeOrmModule.forFeature([AnalyticsEvent, AnalyticsDailyMetric])],
  controllers: [AdminAnalyticsController, EventsIngestionController],
  providers: [AnalyticsService, AnalyticsAggregatorService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
