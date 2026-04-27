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

// ⚠️  VERIFY these import paths match your P1.5a entity files.
import { MealPackage } from '../meal-packages/meal-package.entity';
import { PackageAddon } from '../meal-packages/package-addon.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      Cook,
      User,
      MenuItem,
      Payment,
      // ─── P1.5c: Package repos needed for price calculation ─
      MealPackage,
      PackageAddon,
    ]),
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
