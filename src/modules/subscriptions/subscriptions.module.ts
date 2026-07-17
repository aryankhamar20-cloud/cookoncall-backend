import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { Subscription } from './subscription.entity';
import { SubscriptionRun } from './subscription-run.entity';
import { Cook } from '../cooks/cook.entity';
import { BookingsModule } from '../bookings/bookings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, SubscriptionRun, Cook]),
    // BookingsModule exports BookingsService — the generation cron replays
    // each subscription's template through createBooking.
    BookingsModule,
  ],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
