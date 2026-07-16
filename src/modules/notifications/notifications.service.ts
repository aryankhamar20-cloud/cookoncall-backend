import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Notification, NotificationType } from './notification.entity';
import { User } from '../users/user.entity';
import { AnalyticsService } from '../analytics/analytics.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import {
  CHEF_BOOKING_CONFIRMED,
  CHEF_BOOKING_REQUEST,
  CUSTOMER_BOOKING_CONFIRMED,
  CUSTOMER_BOOKING_REJECTED,
} from '../whatsapp/templates';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly brevoApiKey: string;

  constructor(
    @InjectRepository(Notification)
    private notificationsRepository: Repository<Notification>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectQueue('email') private emailQueue: Queue,
    @InjectQueue('sms') private smsQueue: Queue,
    private configService: ConfigService,
    // Round 4 / Analytics Phase 2 — record `notification_clicked`
    // events so the admin Broadcast panel can show CTR per blast.
    private readonly analytics: AnalyticsService,
    // WhatsApp Phase 2 (May 29, 2026) — chef booking-request approval
    // template sends through here. The service short-circuits when
    // WHATSAPP_* env is unset, so this dep is safe in dev / preview /
    // CI without WABA credentials.
    private readonly whatsapp: WhatsAppService,
  ) {
    this.brevoApiKey = this.configService.get<string>('BREVO_API_KEY', '');
  }

  // ─── PREFERENCES ──────────────────────────────────────
  /**
   * Round 4 — honor the user's notification-channel preferences before
   * queuing email / SMS / push.
   *
   * Design notes:
   *   • In-app rows are NEVER suppressed — the user has to be able to
   *     see their booking timeline when they open the app, regardless
   *     of channel mutes. `create()` always inserts.
   *   • OTP / verification emails are sent from AuthService directly
   *     and bypass this gate (security baseline; users can't opt out
   *     of being told "your account just signed in").
   *   • Failure to read the prefs row defaults to ALLOW the channel
   *     so a transient DB hiccup doesn't drop a booking confirmation.
   */
  private async _channelAllowed(
    userId: string | null,
    channel: 'email' | 'sms' | 'push' | 'whatsapp',
  ): Promise<boolean> {
    if (!userId) return true;
    try {
      const u = await this.usersRepository.findOne({
        where: { id: userId },
        select: [
          'id',
          'email_enabled',
          'sms_enabled',
          'push_enabled',
          'whatsapp_enabled',
        ] as any,
      });
      if (!u) return true;
      if (channel === 'email') return u.email_enabled !== false;
      if (channel === 'sms') return u.sms_enabled !== false;
      if (channel === 'push') return u.push_enabled !== false;
      // WhatsApp opt-in (Phase 1, May 29 2026). Default-allow when
      // the column read failed or returned undefined for the same
      // reason every other channel does — a transient DB hiccup
      // shouldn't drop a chef's booking-request notification.
      if (channel === 'whatsapp') return u.whatsapp_enabled !== false;
      return true;
    } catch (err: any) {
      this.logger.warn(
        `Could not read notification prefs for ${userId} (${channel}): ${err?.message || err}. Defaulting to allow.`,
      );
      return true;
    }
  }

  // ─── CREATE IN-APP NOTIFICATION ───────────────────────
  /**
   * Create a notification, with optional idempotency.
   *
   * If `idempotencyKey` is provided, an existing row for the same
   * (user_id, idempotency_key) is returned instead of inserting a
   * duplicate. This protects every notification source — Bull retry,
   * webhook re-delivery, cron re-run — from spamming the user.
   */
  async create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    metadata?: Record<string, any>,
    idempotencyKey?: string,
  ) {
    if (idempotencyKey) {
      const existing = await this.notificationsRepository.findOne({
        where: { user_id: userId, idempotency_key: idempotencyKey },
      });
      if (existing) {
        return existing;
      }
    }

    const notification = this.notificationsRepository.create({
      user_id: userId,
      type,
      title,
      message,
      metadata,
      idempotency_key: idempotencyKey ?? null,
    });

    try {
      return await this.notificationsRepository.save(notification);
    } catch (err: any) {
      // Race condition: a concurrent create() with the same idempotency
      // key won the insert. Re-fetch and return that row instead of
      // bubbling the unique-violation up.
      if (idempotencyKey && /duplicate key|unique/i.test(err?.message || '')) {
        const existing = await this.notificationsRepository.findOne({
          where: { user_id: userId, idempotency_key: idempotencyKey },
        });
        if (existing) return existing;
      }
      throw err;
    }
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

  // ─── RECORD CLICK (Analytics Phase 2) ────────────────
  /**
   * The user actually opened / tapped this notification.
   *
   * - Sets `clicked_at` exactly once (subsequent calls are a no-op so
   *   we don't double-count CTR).
   * - Also flips `is_read` for free — opening implies reading.
   * - Emits a `notification_clicked` analytics event with the
   *   broadcast_id pulled from the notification's metadata so the
   *   admin Broadcast panel can compute click-through-rate per blast.
   */
  async recordClick(userId: string, notificationId: string) {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId, user_id: userId },
    });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    // First click only — re-clicks (e.g. user reopens the same alert)
    // don't inflate CTR.
    const isFirstClick = !notification.clicked_at;
    if (isFirstClick) {
      await this.notificationsRepository.update(
        { id: notificationId, user_id: userId },
        { clicked_at: new Date(), is_read: true },
      );

      // Best-effort analytics. Wrapped in catch so a logging failure
      // never breaks the user's tap.
      const broadcastId =
        (notification.metadata && (notification.metadata as any).broadcast_id) ||
        null;
      this.analytics
        .track({
          event_type: 'notification_clicked',
          user_id: userId,
          metadata: {
            notification_id: notificationId,
            notification_type: notification.type,
            broadcast_id: broadcastId,
          },
        })
        .catch((): void => undefined);
    }

    return {
      clicked: true,
      first_click: isFirstClick,
    };
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
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Brevo email failed for ${to}: ${msg}`);
    }
  }

  // ─── DIRECT BREVO EMAIL WITH PDF ATTACHMENT ──────────────────
  // Used to email an invoice/receipt PDF. Brevo accepts base64 file
  // content via the `attachment` field (HTTPS, so it works on Railway
  // where SMTP is blocked). Returns true on success so callers can tell
  // the user whether the email actually went out.
  async sendEmailWithAttachment(
    to: string,
    subject: string,
    html: string,
    attachment: { name: string; content: Buffer },
  ): Promise<boolean> {
    if (!this.brevoApiKey || !to) {
      this.logger.warn(
        `BREVO_API_KEY missing or no recipient — skipping invoice email to ${to}`,
      );
      return false;
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
          attachment: [
            { name: attachment.name, content: attachment.content.toString('base64') },
          ],
        }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        this.logger.error(
          `Brevo attachment email error (${response.status}): ${JSON.stringify(result)}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Brevo attachment email failed for ${to}: ${msg}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════
  // BOOKING NOTIFICATION HELPERS
  // ═══════════════════════════════════════════════════════

  /**
   * Booking created — notify the chef AND the customer.
   *
   * Channel matrix (matches every other booking helper in this file):
   *
   *                       in-app row    email
   *   chef                always         if channel allowed AND email known
   *   customer            always         (none — sent separately by
   *                                      bookings.service.sendBookingReceiptEmail
   *                                      which uses the full receipt template)
   *
   * The chef email is the missing piece that this method previously
   * lacked — without it, the chef would only see new requests if they
   * happened to be looking at the dashboard. The bug was reported as
   * "customer gets booking confirmation, cook never gets a request
   * email when customer books a cook". Fixed by sending a Brevo email
   * via the same fire-and-forget `sendDirectEmail` helper as every
   * other chef-side stage notification (notifyChefAccepted,
   * notifyChefRejected, notifyBookingExpired, etc.).
   */
  async notifyBookingCreated(
    userId: string,
    cookUserId: string,
    bookingId: string,
    customerName: string,
    chefDetails?: {
      cookEmail: string | null;
      // WhatsApp Phase 2 (May 29, 2026) — chef booking-request via
      // WhatsApp uses this. Stored on User.phone (varchar(15));
      // WhatsAppService normalises to E.164 internally so any plausible
      // input format is accepted.
      cookPhone?: string | null;
      chefName: string;
      scheduledAt: Date;
      address: string;
      // Approx total — informational only, surfacing nothing the chef
      // doesn't already see in the in-app row.
      totalPrice: number;
    },
  ) {
    // 1. Chef in-app notification (always).
    await this.create(
      cookUserId,
      NotificationType.BOOKING_CREATED,
      'New Booking Request',
      `${customerName} has placed a new booking request. You have 3 hours to accept or decline.`,
      { booking_id: bookingId },
    );

    // 2. Customer in-app notification (always).
    await this.create(
      userId,
      NotificationType.BOOKING_CREATED,
      'Booking Placed',
      'Your booking request has been sent to the chef. You will be notified once they respond.',
      { booking_id: bookingId },
    );

    if (!chefDetails) return;

    // Format once — used by both the email branch and the WhatsApp
    // branch below. Cheap (microseconds), keeps the two branches in
    // lockstep on the date/time strings the chef sees.
    const shortId = bookingId.slice(0, 8).toUpperCase();
    const dateStr = chefDetails.scheduledAt.toLocaleDateString('en-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeStr = chefDetails.scheduledAt.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    });

    // 3. Chef email (channel-gated). Same call shape as
    //    notifyChefAccepted's customer-email branch above.
    if (chefDetails.cookEmail) {
      const subject = `New Booking Request — #${shortId} | CookOnCall`;
      const html = this.wrapBrandedHtml(
        'New booking request',
        `<p style="color:#5D4E37;font-size:14px;line-height:1.6;">
           Hi <strong>${chefDetails.chefName}</strong>, you have a new booking request from
           <strong>${customerName}</strong>. Please accept or decline within
           <strong>3 hours</strong> — after that the request expires automatically.
         </p>
         <table style="width:100%;font-size:14px;border-collapse:collapse;margin-top:8px;">
           <tr><td style="padding:6px 0;color:#8B7355;width:40%;">Booking ID</td><td style="padding:6px 0;color:#2D1810;font-weight:600;">#${shortId}</td></tr>
           <tr><td style="padding:6px 0;color:#8B7355;">Date</td><td style="padding:6px 0;color:#2D1810;">${dateStr}</td></tr>
           <tr><td style="padding:6px 0;color:#8B7355;">Time</td><td style="padding:6px 0;color:#2D1810;">${timeStr}</td></tr>
           <tr><td style="padding:6px 0;color:#8B7355;vertical-align:top;">Address</td><td style="padding:6px 0;color:#2D1810;">${chefDetails.address}</td></tr>
           <tr><td style="padding:6px 0;color:#8B7355;">Estimated total</td><td style="padding:6px 0;color:#2D1810;font-weight:600;">&#8377;${chefDetails.totalPrice.toFixed(2)}</td></tr>
         </table>
         <p style="color:#8B7355;font-size:13px;line-height:1.6;margin-top:16px;">
           Open the CookOnCall app &rarr; Orders &rarr; Accept or Decline.
         </p>`,
      );
      if (await this._channelAllowed(cookUserId, 'email')) {
        this.sendDirectEmail(chefDetails.cookEmail, subject, html).catch(
          (): void => undefined,
        );
      }
    }

    // 4. Chef WhatsApp (Phase 2 — channel-gated). Identical gating
    //    semantics to the email branch above:
    //      - skipped when chef has no phone on file;
    //      - skipped when chef has muted the channel
    //        (`whatsapp_enabled === false`);
    //      - silently no-ops when WHATSAPP_* env is unset (the
    //        WhatsAppService short-circuits inside `sendTemplate`).
    //
    //    The Approve/Decline quick-reply buttons carry payloads of the
    //    form `APPROVE_<bookingId>` / `REJECT_<bookingId>`. Phase 3's
    //    inbound webhook routes those payloads back into
    //    BookingsService.acceptBooking / rejectBooking using the chef's
    //    phone number as the auth boundary.
    //
    //    Failure is fire-and-forget — WhatsApp going dark must never
    //    break the in-app + email path the user already relies on.
    if (chefDetails.cookPhone) {
      const allowWhatsApp = await this._channelAllowed(cookUserId, 'whatsapp');
      if (allowWhatsApp) {
        try {
          await this.whatsapp.sendTemplate({
            to: chefDetails.cookPhone,
            template: CHEF_BOOKING_REQUEST,
            vars: [
              this.sanitizeForWhatsAppVar(chefDetails.chefName, 64),
              this.sanitizeForWhatsAppVar(customerName, 64),
              shortId,
              this.sanitizeForWhatsAppVar(dateStr, 80),
              this.sanitizeForWhatsAppVar(timeStr, 32),
              this.sanitizeForWhatsAppVar(chefDetails.address, 200),
              chefDetails.totalPrice.toFixed(0),
            ],
            // CHEF_BOOKING_REQUEST template registers two quick-reply
            // buttons (Approve / Decline). buttonSuffixes is mapped 1:1
            // onto template.buttons → emitted payloads are
            // `APPROVE_<bookingId>` and `REJECT_<bookingId>`.
            buttonSuffixes: [bookingId, bookingId],
            correlationId: bookingId,
          });
        } catch (err) {
          // sendTemplate is designed to never throw — but be defensive,
          // failure here cannot block the booking flow.
          this.logger.warn(
            `WhatsApp chef-request failed for booking ${shortId}: ${
              (err as Error).message
            }`,
          );
        }
      }
    }
  }

  /**
   * Sanitise a free-text string for use as a WhatsApp template variable.
   *
   * Meta rejects template body parameters that contain raw newlines,
   * tabs, or 4+ consecutive whitespace characters. Long values get
   * trimmed to `maxLen` so we stay under the per-component 1024-char
   * limit even after Meta concatenates with the template's static text.
   */
  private sanitizeForWhatsAppVar(value: string, maxLen: number): string {
    return String(value ?? '')
      .replace(/[\r\n\t]+/g, ', ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, maxLen);
  }

  /**
   * Chef accepted → notify customer.
   *
   * New flow (May 29, 2026): chef accept goes straight to CONFIRMED
   * (no separate AWAITING_PAYMENT step / 3-hour payment window). Payment
   * is optional any time before the chef closes the session via the
   * end-OTP — see bookings.service.verifyEndOtp for the gate.
   *
   * Copy was previously "Please complete payment within 3 hours to
   * confirm." That's wrong now: the booking is already confirmed and
   * the customer has until session-end to pay.
   */
  async notifyChefAccepted(
    customerUserId: string,
    customerEmail: string | null,
    bookingId: string,
    chefName: string,
    // WhatsApp Phase 4 (May 29, 2026) — when supplied, the customer
    // and chef each receive a confirmation WhatsApp template after
    // the chef's accept. Optional so legacy callers (none today)
    // continue to work — when omitted, the in-app + email behaviour
    // is byte-identical to pre-Phase-4.
    whatsappDetails?: {
      customerName: string;
      customerPhone: string | null;
      // Chef channel-pref gate uses this.
      chefUserId: string;
      chefPhone: string | null;
      // Used to format the date_str / time_str template vars so
      // both parties see the same booking time the customer saw at
      // creation time. Pulled from the Booking row at the call site.
      scheduledAt: Date;
    },
  ) {
    const title = 'Booking confirmed';
    const message =
      `${chefName} accepted your booking — you're all set! ` +
      `Payment is optional now and due any time before your session ends.`;
    await this.create(
      customerUserId,
      NotificationType.BOOKING_CHEF_ACCEPTED,
      title,
      message,
      { booking_id: bookingId },
    );

    if (customerEmail) {
      const html = this.wrapBrandedHtml(
        'Your booking is confirmed!',
        `<p style="color:#5D4E37;font-size:14px;line-height:1.6;">
          <strong>${chefName}</strong> accepted your booking. You're all set.
        </p>
        <p style="color:#8B7355;font-size:13px;line-height:1.6;">
          <strong>Payment is optional</strong> until your session ends — you can pay any time
          from the CookOnCall app under <em>Orders &rarr; Pay</em>. The chef will not be
          able to mark the session complete until payment is captured, so make sure
          to pay before they finish cooking.
        </p>
        <p style="color:#8B7355;font-size:13px;line-height:1.6;">
          <em>If you already paid, please ignore this email.</em>
        </p>`,
      );
      if (await this._channelAllowed(customerUserId, 'email')) {
        this.sendDirectEmail(customerEmail, title, html).catch((): void => undefined);
      }
    }

    // ─── WhatsApp confirmations (Phase 4) ──────────────
    // Two independent sends, each with its own gate:
    //   1. Customer side — confirms the booking is live, mirrors the
    //      branded email body's payment-optional-until-session-end
    //      messaging in template form.
    //   2. Chef side — keeps the chef's WhatsApp thread coherent.
    //      WhatsApp quick-reply button taps don't auto-acknowledge in
    //      the chat (the chef sees their own button tap and then
    //      silence); CHEF_BOOKING_CONFIRMED is the visible "we got
    //      your accept" receipt. Sent regardless of which channel
    //      the chef accepted through (web, mobile, WhatsApp button)
    //      so the thread always has the booking summary for reference.
    //
    // Failure on either branch is fire-and-forget — never blocks the
    // booking flow.
    if (whatsappDetails) {
      const shortId = bookingId.slice(0, 8).toUpperCase();
      const dateStr = whatsappDetails.scheduledAt.toLocaleDateString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const timeStr = whatsappDetails.scheduledAt.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const customerNameVar = this.sanitizeForWhatsAppVar(
        whatsappDetails.customerName,
        64,
      );
      const chefNameVar = this.sanitizeForWhatsAppVar(chefName, 64);
      const dateVar = this.sanitizeForWhatsAppVar(dateStr, 80);
      const timeVar = this.sanitizeForWhatsAppVar(timeStr, 32);

      // 1. Customer-side WhatsApp.
      if (
        whatsappDetails.customerPhone &&
        (await this._channelAllowed(customerUserId, 'whatsapp'))
      ) {
        try {
          await this.whatsapp.sendTemplate({
            to: whatsappDetails.customerPhone,
            template: CUSTOMER_BOOKING_CONFIRMED,
            vars: [customerNameVar, chefNameVar, dateVar, timeVar, shortId],
            correlationId: bookingId,
          });
        } catch (err) {
          this.logger.warn(
            `WhatsApp customer-confirmed failed for booking ${shortId}: ${
              (err as Error).message
            }`,
          );
        }
      }

      // 2. Chef-side WhatsApp.
      if (
        whatsappDetails.chefPhone &&
        (await this._channelAllowed(whatsappDetails.chefUserId, 'whatsapp'))
      ) {
        try {
          await this.whatsapp.sendTemplate({
            to: whatsappDetails.chefPhone,
            template: CHEF_BOOKING_CONFIRMED,
            vars: [chefNameVar, customerNameVar, dateVar, timeVar, shortId],
            correlationId: bookingId,
          });
        } catch (err) {
          this.logger.warn(
            `WhatsApp chef-confirmed failed for booking ${shortId}: ${
              (err as Error).message
            }`,
          );
        }
      }
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
    // WhatsApp Phase 4 (May 29, 2026) — customer-side WhatsApp
    // rejection notice. Chef side intentionally not notified here
    // because their decline tap (or web-app button click) IS the
    // confirmation; sending another WhatsApp message saying "you
    // declined" would just clutter the thread.
    whatsappDetails?: {
      customerName: string;
      customerPhone: string | null;
    },
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
      if (await this._channelAllowed(customerUserId, 'email')) {
        this.sendDirectEmail(customerEmail, title, html).catch((): void => undefined);
      }
    }

    // ─── Customer WhatsApp rejection (Phase 4) ─────────
    // No reason exposed — same contract as the email above. Reason
    // stays in `bookings.rejection_reason`, admin-only. The customer
    // sees enough to know the booking didn't go through and that
    // they can rebook elsewhere.
    if (
      whatsappDetails?.customerPhone &&
      (await this._channelAllowed(customerUserId, 'whatsapp'))
    ) {
      try {
        await this.whatsapp.sendTemplate({
          to: whatsappDetails.customerPhone,
          template: CUSTOMER_BOOKING_REJECTED,
          vars: [
            this.sanitizeForWhatsAppVar(whatsappDetails.customerName, 64),
            this.sanitizeForWhatsAppVar(chefName, 64),
          ],
          correlationId: bookingId,
        });
      } catch (err) {
        this.logger.warn(
          `WhatsApp customer-rejected failed for booking ${bookingId.slice(0, 8)}: ${
            (err as Error).message
          }`,
        );
      }
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
        // Customer-side expiry: under the new flow this is reachable
        // only for legacy bookings still stuck in AWAITING_PAYMENT (old
        // flow's 3-hour payment window). New CONFIRMED bookings don't
        // auto-expire by payment timer.
        : 'Your booking expired before it could be confirmed. ' +
          'You can book another chef at no extra charge.';
    await this.create(
      recipientUserId,
      NotificationType.BOOKING_EXPIRED,
      title,
      message,
      { booking_id: bookingId },
    );

    if (recipientEmail) {
      const html = this.wrapBrandedHtml('Booking expired', `<p style="color:#5D4E37;">${message}</p>`);
      if (await this._channelAllowed(recipientUserId, 'email')) {
        this.sendDirectEmail(recipientEmail, title, html).catch((): void => undefined);
      }
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
