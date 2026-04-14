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

  // ═══════════════════════════════════════════════════════
  // BOOKING NOTIFICATION HELPERS
  // ═══════════════════════════════════════════════════════

  /** Booking created → notify the chef */
  async notifyBookingCreated(
    userId: string,
    cookUserId: string,
    bookingId: string,
    customerName: string,
  ) {
    // Notify the chef
    await this.create(
      cookUserId,
      NotificationType.BOOKING_CREATED,
      'New Booking Request',
      `${customerName} has placed a new booking request. Please accept or decline.`,
      { booking_id: bookingId },
    );

    // Notify the customer (confirmation that booking was placed)
    await this.create(
      userId,
      NotificationType.BOOKING_CREATED,
      'Booking Placed',
      'Your booking request has been sent to the chef. You will be notified once they respond.',
      { booking_id: bookingId },
    );
  }

  /** Chef accepted → notify customer */
  async notifyBookingConfirmed(userId: string, bookingId: string, chefName: string) {
    await this.create(
      userId,
      NotificationType.BOOKING_CONFIRMED,
      'Booking Confirmed',
      `${chefName} has accepted your booking! Get ready for a great meal.`,
      { booking_id: bookingId },
    );
  }

  /** Chef rejected → notify customer */
  async notifyBookingDeclined(userId: string, bookingId: string, chefName: string) {
    await this.create(
      userId,
      NotificationType.BOOKING_CANCELLED,
      'Booking Declined',
      `${chefName} was unable to accept your booking. Please try another chef.`,
      { booking_id: bookingId },
    );
  }

  /** Booking cancelled → notify the other party */
  async notifyBookingCancelled(
    recipientUserId: string,
    bookingId: string,
    cancelledBy: string,
  ) {
    await this.create(
      recipientUserId,
      NotificationType.BOOKING_CANCELLED,
      'Booking Cancelled',
      `The booking has been cancelled by the ${cancelledBy}.`,
      { booking_id: bookingId },
    );
  }

  /** Cooking started → notify customer */
  async notifySessionStarted(userId: string, bookingId: string, chefName: string) {
    await this.create(
      userId,
      NotificationType.BOOKING_STARTED,
      'Cooking Started',
      `${chefName} has started cooking! Session is now in progress.`,
      { booking_id: bookingId },
    );
  }

  /** Cooking completed → notify both */
  async notifySessionCompleted(
    userId: string,
    cookUserId: string,
    bookingId: string,
    durationMinutes: number,
  ) {
    const hrs = Math.floor(durationMinutes / 60);
    const mins = durationMinutes % 60;
    const durationStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins} minutes`;

    // Notify customer
    await this.create(
      userId,
      NotificationType.BOOKING_COMPLETED,
      'Cooking Session Complete',
      `The cooking session is complete! Duration: ${durationStr}. Please leave a review for your chef.`,
      { booking_id: bookingId, duration_minutes: durationMinutes },
    );

    // Notify chef
    await this.create(
      cookUserId,
      NotificationType.BOOKING_COMPLETED,
      'Session Complete',
      `Session completed. Duration: ${durationStr}. Earnings will be added to your account.`,
      { booking_id: bookingId, duration_minutes: durationMinutes },
    );
  }

  /** Prompt customer to review after completion */
  async notifyReviewPrompt(userId: string, bookingId: string, chefName: string) {
    await this.create(
      userId,
      NotificationType.REVIEW_PROMPT,
      'How was your experience?',
      `Please rate your cooking session with ${chefName}. Your review helps other customers!`,
      { booking_id: bookingId },
    );
  }

  /** Review received → notify chef */
  async notifyReviewReceived(cookUserId: string, rating: number, reviewerName: string) {
    await this.create(
      cookUserId,
      NotificationType.REVIEW_RECEIVED,
      'New Review',
      `${reviewerName} gave you a ${rating}-star review.`,
    );
  }

  /** Chef verified → notify chef */
  async notifyCookVerified(cookUserId: string) {
    await this.create(
      cookUserId,
      NotificationType.COOK_VERIFIED,
      'Profile Verified!',
      'Congratulations! Your profile has been verified. You can now go online and start receiving bookings.',
    );
  }

  /** Chef rejected → notify chef */
  async notifyCookRejected(cookUserId: string, reason?: string) {
    const msg = reason
      ? `Your verification was not approved. Reason: ${reason}. Please update your documents and resubmit.`
      : 'Your verification was not approved. Please check your documents and resubmit.';

    await this.create(
      cookUserId,
      NotificationType.COOK_REJECTED,
      'Verification Not Approved',
      msg,
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
