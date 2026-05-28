import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EmailProcessor } from './email.processor';
import { SmsProcessor } from './sms.processor';
import { Notification } from './notification.entity';
import { FcmService } from '../../common/services/fcm.service';
import { User } from '../users/user.entity';
import { EventsGateway } from './events.gateway';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, User]),
    BullModule.registerQueue(
      { name: 'email' },
      { name: 'sms' },
    ),
    // JWT needed by EventsGateway to verify WS connection tokens
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    EmailProcessor,
    SmsProcessor,
    FcmService,
    // ✅ P1: WebSocket gateway
    EventsGateway,
  ],
  exports: [NotificationsService, EventsGateway],
})
export class NotificationsModule {}
