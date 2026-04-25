import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import {
  AvailabilitySchedule,
  AvailabilityOverride,
} from './availability.entity';
import { Cook } from '../cooks/cook.entity';
import { Booking } from '../bookings/booking.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AvailabilitySchedule,
      AvailabilityOverride,
      Cook,
      Booking,
    ]),
  ],
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
