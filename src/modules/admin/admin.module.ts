import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { User } from '../users/user.entity';
import { Cook } from '../cooks/cook.entity';
import { Booking } from '../bookings/booking.entity';
import { Payment } from '../payments/payment.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, Cook, Booking, Payment])],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
