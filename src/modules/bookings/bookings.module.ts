import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { Booking } from './booking.entity';
import { Cook } from '../cooks/cook.entity';
import { User } from '../users/user.entity';
import { MenuItem } from '../cooks/menu-item.entity';
import { Payment } from '../payments/payment.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { AvailabilityModule } from '../availability/availability.module';

// NOTE (Apr 24): BookingsGateway removed — it was dead code (declared but
// never emitted from). We rely on pull-to-refresh / polling for now.
// Real-time updates will be re-introduced via Supabase Realtime post-launch.

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, Cook, User, MenuItem, Payment]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
    NotificationsModule,
    AvailabilityModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
