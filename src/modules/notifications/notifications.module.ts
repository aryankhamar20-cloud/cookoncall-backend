import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EmailProcessor } from './email.processor';
import { SmsProcessor } from './sms.processor';
import { Notification } from './notification.entity';
import { User } from '../users/user.entity';
import { AnalyticsModule } from '../analytics/analytics.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    // Round 4: NotificationsService reads the User row to honor
    // `email_enabled` / `sms_enabled` / `push_enabled` flags before
    // queuing transactional channels. We register User locally here
    // (rather than importing UsersModule) to avoid a circular dep.
    TypeOrmModule.forFeature([Notification, User]),
    BullModule.registerQueue(
      { name: 'email' },
      { name: 'sms' },
    ),
    // Analytics Phase 2 — recordClick() emits `notification_clicked`
    // events through AnalyticsService. forwardRef guards against the
    // theoretical circular import path AnalyticsModule -> AdminModule
    // -> NotificationsModule that already exists in this codebase.
    forwardRef(() => AnalyticsModule),
    // WhatsApp Phase 2 — notifyBookingCreated calls WhatsAppService
    // .sendTemplate(CHEF_BOOKING_REQUEST, ...) when the chef has a
    // phone + has not muted the channel. WhatsAppModule's `exports`
    // expose WhatsAppService; no forwardRef needed here because
    // WhatsAppModule does NOT import NotificationsModule (one-way
    // dependency at this point — Phase 3 will introduce the back-edge
    // via BookingsModule and resolve it locally with forwardRef).
    WhatsAppModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, EmailProcessor, SmsProcessor],
  exports: [NotificationsService],
})
export class NotificationsModule {}
