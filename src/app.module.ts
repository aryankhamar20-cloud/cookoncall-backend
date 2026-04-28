import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CooksModule } from './modules/cooks/cooks.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AdminModule } from './modules/admin/admin.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { AddressesModule } from './modules/addresses/addresses.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { MealPackagesModule } from './modules/meal-packages/meal-packages.module';
import { AreasModule } from './modules/areas/areas.module';
import { databaseConfig } from './config/database.config';
import { redisConfig } from './config/redis.config';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
// add SchedulerModule to the imports array

@Module({
  imports: [
    // Environment
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Database
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: databaseConfig,
    }),

    // Rate limiting
    // General: 100 requests per 60s per IP (all endpoints)
    // Strict:  10 requests per 60s per IP (auth endpoints — login, register, OTP)
    // The auth controller uses @Throttle({ strict: [...] }) to apply the strict tier
    ThrottlerModule.forRoot([
      {
        name: 'general',
        ttl: 60000,  // 60 seconds
        limit: 100,
      },
      {
        name: 'strict',
        ttl: 60000,  // 60 seconds
        limit: 10,
      },
    ]),

    // Queue (Bull + Redis)
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: redisConfig,
    }),

    // Cron jobs
    ScheduleModule.forRoot(),

    // Feature modules
    AuthModule,
    UsersModule,
    CooksModule,
    BookingsModule,
    PaymentsModule,
    ReviewsModule,
    NotificationsModule,
    AdminModule,
    UploadsModule,
    AddressesModule,
    AvailabilityModule,
    MealPackagesModule,
    AreasModule,
  ],
  providers: [
    // Apply ThrottlerGuard globally to ALL endpoints
    // Individual controllers/routes can use @SkipThrottle() to opt out
    // or @Throttle({ strict: [...] }) to use stricter limits
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
