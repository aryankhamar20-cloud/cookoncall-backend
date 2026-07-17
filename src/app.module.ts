import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
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
import { ErrorsModule } from './modules/errors/errors.module';
import { HealthModule } from './modules/health/health.module';
import { EventsModule } from './modules/events/events.module';
import { PromoCodesModule } from './modules/promo-codes/promo-codes.module';
import { ReferralsModule } from './modules/referrals/referrals.module';
import { FavoritesModule } from './modules/favorites/favorites.module';
import { PayoutsModule } from './modules/payouts/payouts.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { LoggerMiddleware } from './common/middleware/logger.middleware';
import { CommonModule } from './common/common.module';

@Module({
  imports: [
    // Environment
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Shared infrastructure (Redis cache, response-cache interceptor) —
    // marked @Global so feature modules can use it without re-importing.
    CommonModule,

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
    FavoritesModule,
    PayoutsModule,
    SubscriptionsModule,
    DisputesModule,
    WalletModule,
    NotificationsModule,
    AdminModule,
    UploadsModule,
    AddressesModule,
    AvailabilityModule,
    MealPackagesModule,
    AreasModule,
    ErrorsModule,
    SchedulerModule,
    // New P0/P1/P2 modules
    HealthModule,
    EventsModule,
    PromoCodesModule,
    ReferralsModule,
    // Analytics Phase 1
    AnalyticsModule,
    // WhatsApp Phase 1 — provider-agnostic scaffolding.
    // No-op when WHATSAPP_* env vars are unset; once configured the
    // queue + processor + Meta Cloud provider are immediately live.
    WhatsAppModule,
  ],
  providers: [
    // Apply ThrottlerGuard globally to ALL endpoints
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
