import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { ReceiptService } from './receipt.service';
import { Booking } from './booking.entity';
import { Cook } from '../cooks/cook.entity';
import { User } from '../users/user.entity';
import { MenuItem } from '../cooks/menu-item.entity';
import { Payment } from '../payments/payment.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { AvailabilityModule } from '../availability/availability.module';
import { PromoCodesModule } from '../promo-codes/promo-codes.module';
import { ReferralsModule } from '../referrals/referrals.module';

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
    // Customer promo-code redemption flow (May 29, 2026) — bookings.service
    // calls PromoCodesService.validate() during createBooking and
    // recordUsage() after the booking row saves.
    PromoCodesModule,
    // Referral rewards on booking completion (credits referrer's wallet).
    ReferralsModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService, ReceiptService],
  exports: [BookingsService],
})
export class BookingsModule {}
