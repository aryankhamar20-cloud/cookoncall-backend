import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Notification, NotificationType } from './notification.entity';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private notificationsRepository: Repository<Notification>,
    @InjectQueue('email') private emailQueue: Queue,
    @InjectQueue('sms') private smsQueue: Queue,
    private configService: ConfigService,
  ) {}

  // ─── CREATE IN-APP NOTIFICATION ───────────────────────
  async create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    metadata?: Record<string, any>,
  ) {
    const notification = this.notificationsRepository.create({
      user_id: userId,
      type,
      title,
      message,
      metadata,
    });

    return this.notificationsRepository.save(notification);
  }

  // ─── GET USER NOTIFICATIONS ───────────────────────────
  async getUserNotifications(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [notifications, total] =
      await this.notificationsRepository.findAndCount({
        where: { user_id: userId },
        order: { created_at: 'DESC' },
        skip,
        take: limit,
      });

    const unread = await this.notificationsRepository.count({
      where: { user_id: userId, is_read: false },
    });

    return {
      notifications,
      unread_count: unread,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    };
  }

  // ─── MARK AS READ ─────────────────────────────────────
  async markAsRead(userId: string, notificationId: string) {
    await this.notificationsRepository.update(
      { id: notificationId, user_id: userId },
      { is_read: true },
    );
    return { message: 'Marked as read' };
  }

  // ─── MARK ALL READ ────────────────────────────────────
  async markAllRead(userId: string) {
    await this.notificationsRepository.update(
      { user_id: userId, is_read: false },
      { is_read: true },
    );
    return { message: 'All notifications marked as read' };
  }

  // ─── SEND EMAIL (via Bull Queue) ──────────────────────
  async sendEmail(to: string, subject: string, html: string) {
    await this.emailQueue.add(
      'send-email',
      { to, subject, html },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  }

  // ─── SEND SMS (via Bull Queue) ─────────────────────────
  async sendSms(phone: string, message: string) {
    await this.smsQueue.add(
      'send-sms',
      { phone, message },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  }

  // ─── BOOKING NOTIFICATION HELPERS ─────────────────────

  async notifyBookingCreated(
    userId: string,
    cookUserId: string,
    bookingId: string,
  ) {
    await this.create(
      cookUserId,
      NotificationType.BOOKING_CREATED,
      'New Booking Request',
      'You have a new booking request. Please accept or decline within 10 minutes.',
      { booking_id: bookingId },
    );
  }

  async notifyBookingConfirmed(userId: string, bookingId: string) {
    await this.create(
      userId,
      NotificationType.BOOKING_CONFIRMED,
      'Booking Confirmed',
      'Your booking has been confirmed by the cook!',
      { booking_id: bookingId },
    );
  }

  async notifyBookingCancelled(
    userId: string,
    bookingId: string,
    cancelledBy: string,
  ) {
    await this.create(
      userId,
      NotificationType.BOOKING_CANCELLED,
      'Booking Cancelled',
      `Your booking has been cancelled by the ${cancelledBy}.`,
      { booking_id: bookingId },
    );
  }

  async notifyPaymentReceived(userId: string, amount: number) {
    await this.create(
      userId,
      NotificationType.PAYMENT_RECEIVED,
      'Payment Received',
      `Payment of ₹${amount} has been received.`,
    );
  }
}
