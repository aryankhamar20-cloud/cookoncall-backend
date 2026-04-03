import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { Review } from './review.entity';
import { Booking } from '../bookings/booking.entity';
import { Cook } from '../cooks/cook.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Review, Booking, Cook])],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
