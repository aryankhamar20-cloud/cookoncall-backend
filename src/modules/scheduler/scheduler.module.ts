import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { BookingsModule } from '../bookings/bookings.module';

/**
 * SchedulerModule — P1.5d
 *
 * 1. Install dependency first:
 *    npm install @nestjs/schedule
 *
 * 2. Add SchedulerModule to the `imports` array in app.module.ts:
 *    import { SchedulerModule } from './scheduler/scheduler.module';
 *    ...
 *    imports: [ ..., SchedulerModule ],
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    BookingsModule,            // exports BookingsService → used by SchedulerService
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
