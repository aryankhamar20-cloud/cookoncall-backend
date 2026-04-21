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
  private readonly brevoApiKey: string;

  constructor(
    @InjectRepository(Notification)
    private notificationsRepository: Repository<Notification>,
    @InjectQueue('email') private emailQueue: Queue,
    @InjectQueue('sms') private smsQueue: Queue,
    private configService: ConfigService,
  ) {
    this.brevoApiKey = this.configService.get<string>('BREVO_API_KEY', '');
  }

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

  // ─── DIRECT BREVO EMAIL (non-queued — used by booking flow) ───
  // Railway blocks SMTP; we use Brevo HTTP API. Fire-and-forget; failure
  // is logged but never breaks the calling flow.
  async sendDirectEmail(to: string, subject: string, html: string) {
    if (!this.brevoApiKey || !to) {
      this.logger.warn(`BREVO_API_KEY missing or no recipient — skipping email to ${to}`);
      return;
    }
    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.brevoApiKey,
        },
        body: JSON.stringify({
          sender: { name: 'CookOnCall', email: 'support@thecookoncall.com' },
          to: [{ email: to }],
          subject,
          htmlContent: html,
        }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        this.logger.error(`Brevo email error (${response.status}): ${JSON.stringify(result)}`);
      }
    } catch (err) {
      this.logger.error(`Brevo email failed for ${to}: ${err?.message || err}`);
    }
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
      `${customerName} has placed a new booking request. You have 3 hours to accept or decline.`,
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

  /** Chef accepted → notify customer (pay within 3 hours) */
  async notifyChefAccepted(
    customerUserId: string,
    customerEmail: string | null,
    bookingId: string,
    chefName: string,
  ) {
    const title = 'Chef accepted — please pay to confirm';
    const message = `${chefName} accepted your booking! Please complete payment within 3 hours to confirm. If you already paid, please ignore this message.`;
    await this.create(
      customerUserId,
      NotificationType.BOOKING_CHEF_ACCEPTED,
      title,
      message,
      { booking_id: bookingId },
    );

    if (customerEmail) {
      const html = this.wrapBrandedHtml(
        'Chef accepted your booking!',
        `<p style="color:#5D4E37;font-size:14px;line-height:1.6;">
          <strong>${chefName}</strong> accepted your booking request. Please complete your payment within <strong>3 hours</strong> to confirm the booking.
        </p>
        <p style="color:#8B7355;font-size:13px;line-height:1.6;">
          Open the CookOnCall app → Orders → Pay Now.<br/>
          <em>If you already paid, please ignore this email.</em>
        </p>`,
      );
      this.sendDirectEmail(customerEmail, title, html).catch(() => undefined);
    }
  }

  /** Legacy helper — kept for payments.service backward compatibility */
  async notifyBookingConfirmed(userId: string, bookingId: string, chefName: string) {
    await this.create(
      userId,
      NotificationType.BOOKING_CONFIRMED,
      'Booking Confirmed',
      `Your booking with ${chefName} is confirmed. See you soon!`,
      { booking_id: bookingId },
    );
  }

  /**
   * Chef rejected → notify customer (NO reason exposed)
   * Reason stays in DB column `rejection_reason`, admin-only.
   */
  async notifyChefRejected(
    customerUserId: string,
    customerEmail: string | null,
    bookingId: string,
    chefName: string,
  ) {
    const title = 'Unable to confirm your booking';
    const message = `Unfortunately ${chefName} is unable to accept your booking. You can book another chef at no extra charge, or close this request.`;
    await this.create(
      customerUserId,
      NotificationType.BOOKING_CHEF_REJECTED,
      title,
      message,
      { booking_id: bookingId },
    );

    if (customerEmail) {
      const html = this.wrapBrandedHtml(
        'We could not confirm this booking',
        `<p style="color:#5D4E37;font-size:14px;line-height:1.6;">
          Unfortunately <strong>${chefName}</strong> could not accept your booking this time. No payment has been taken.
        </p>
        <p style="color:#5D4E37;font-size:14px;line-height:1.6;">
          Open the CookOnCall app to book another chef at no extra charge, or close this request.
        </p>`,
      );
      this.sendDirectEmail(customerEmail, title, html).catch(() => undefined);
    }
  }

  /**
   * Booking expired — notifies the appropriate party.
   * who = 'chef' | 'customer' — who we're notifying.
   */
  async notifyBookingExpired(
    recipientUserId: string,
    recipientEmail: string | null,
    bookingId: string,
    who: 'chef' | 'customer',
  ) {
    const title = 'Booking expired';
    const message =
      who === 'chef'
        ? 'A booking request expired because you did not respond within 3 hours.'
        : 'Your booking expired because payment was not completed within 3 hours.';
    await this.create(
      recipientUserId,
      NotificationType.BOOKING_EXPIRED,
      title,
      message,
      { booking_id: bookingId },
    );

    if (recipientEmail) {
      const html = this.wrapBrandedHtml('Booking expired', `<p style="color:#5D4E37;">${message}</p>`);
      this.sendDirectEmail(recipientEmail, title, html).catch(() => undefined);
    }
  }

  /** Legacy helper kept for callers still using it */
  async notifyBookingDeclined(userId: string, bookingId: string, chefName: string) {
    await this.create(
      userId,
      NotificationType.BOOKING_CANCELLED,
      'Booking Declined',
      `${chefName} was unable to accept your booking.`,
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

    await this.create(
      userId,
      NotificationType.BOOKING_COMPLETED,
      'Cooking Session Complete',
      `The cooking session is complete! Duration: ${durationStr}. Please leave a review for your chef.`,
      { booking_id: bookingId, duration_minutes: durationMinutes },
    );

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

  // ─── Brand email wrapper ─────────────────────────────
  private wrapBrandedHtml(heading: string, bodyHtml: string): string {
    return `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #FFF8F0; border-radius: 16px; padding: 40px 32px; border: 1px solid #FFE4B5;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-weight: 900; font-size: 24px; color: #2D1810;">COOK</span><span style="font-weight: 900; font-size: 24px; color: #D4721A;">ONCALL</span>
        </div>
        <h2 style="text-align:center;color:#2D1810;font-size:20px;margin-bottom:16px;">${heading}</h2>
        <div style="background:white;border-radius:12px;padding:20px;border:1px solid #FFE4B5;">
          ${bodyHtml}
        </div>
        <hr style="border:none;border-top:1px solid #FFE4B5;margin:24px 0;" />
        <p style="text-align:center;color:#B0A090;font-size:11px;">
          &copy; ${new Date().getFullYear()} CookOnCall &middot; Ahmedabad, Gujarat, India
        </p>
      </div>
    `;
  }
}
