import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { User } from '../users/user.entity';
import { Cook } from '../cooks/cook.entity';
import { Booking } from '../bookings/booking.entity';
import { Payment } from '../payments/payment.entity';
import { Review } from '../reviews/review.entity';
import { Notification } from '../notifications/notification.entity';
import { AdminAuditLog } from './admin-audit.entity';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Cook,
      Booking,
      Payment,
      Review,
      Notification,
      AdminAuditLog,
    ]),
    NotificationsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
