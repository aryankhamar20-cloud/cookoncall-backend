import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';
import { Payment, PaymentStatus } from './payment.entity';
import { Booking, BookingStatus } from '../bookings/booking.entity';
import { CreateOrderDto, VerifyPaymentDto } from './dto/payment.dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private razorpay: Razorpay;

  constructor(
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    @InjectRepository(Booking)
    private bookingsRepository: Repository<Booking>,
    private configService: ConfigService,
    private notificationsService: NotificationsService,
  ) {
    this.razorpay = new Razorpay({
      key_id: this.configService.get<string>('RAZORPAY_KEY_ID'),
      key_secret: this.configService.get<string>('RAZORPAY_KEY_SECRET'),
    });
  }

  // ─── CREATE RAZORPAY ORDER ────────────────────────────
  // New flow (May 29, 2026): payment is OPTIONAL between chef-accept and
  // session-end. Customer can pay any time the booking is in CONFIRMED
  // (the post-accept state) or even IN_PROGRESS (chef started cooking
  // but customer hasn't paid yet — still allowed; verifyEndOtp blocks
  // session COMPLETED until payment is captured).
  //
  // Legacy AWAITING_PAYMENT and PENDING values stay payable for any
  // pre-deployment rows that haven't finished yet. The 3-hour
  // payment-window expiry has been removed from acceptBooking; existing
  // rows in AWAITING_PAYMENT can still be paid via the same Razorpay
  // path and will flip to CONFIRMED on capture (handled below).
  async createOrder(userId: string, dto: CreateOrderDto) {
    const booking = await this.bookingsRepository.findOne({
      where: { id: dto.booking_id, user_id: userId },
      relations: ['cook', 'cook.user'],
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    const payableStatuses = [
      BookingStatus.CONFIRMED,
      BookingStatus.IN_PROGRESS,
      BookingStatus.AWAITING_PAYMENT, // legacy
      BookingStatus.PENDING, // legacy
    ];
    if (!payableStatuses.includes(booking.status)) {
      throw new BadRequestException(
        `This booking cannot be paid right now (status: ${booking.status})`,
      );
    }

    const amount = Number(booking.total_price);
    if (!amount || amount <= 49 || Number.isNaN(amount)) {
      throw new BadRequestException('Invalid booking amount — please contact support');
    }

    // Check if payment already exists
    const existingPayment = await this.paymentsRepository.findOne({
      where: { booking_id: dto.booking_id },
    });

    if (existingPayment && existingPayment.status === PaymentStatus.CAPTURED) {
      throw new BadRequestException('Payment already completed');
    }

    // Create Razorpay order
    const amountInPaise = Math.round(amount * 100);

    let razorpayOrder;
    try {
      razorpayOrder = await this.razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `bk_${booking.id.replace(/-/g, '').slice(0, 36)}`,
        notes: {
          booking_id: booking.id,
          user_id: userId,
        },
      });
    } catch (error) {
      // Razorpay SDK throws errors with shape { statusCode, error: { code, description, source } }.
      // They aren't always Error instances, so narrow defensively.
      const err = error as {
        message?: string;
        statusCode?: number;
        error?: { description?: string; code?: string };
      };
      const msg = err?.message ?? JSON.stringify(error);
      this.logger.error(`Razorpay order creation failed: ${msg}`);
      this.logger.error(
        `Razorpay error details: statusCode=${err?.statusCode}, error=${JSON.stringify(err?.error)}`,
      );
      throw new BadRequestException(
        `Payment gateway error: ${err?.error?.description ?? err?.message ?? 'Unknown error'}`,
      );
    }

    let payment: Payment;

    if (existingPayment) {
      existingPayment.razorpay_order_id = razorpayOrder.id;
      existingPayment.amount = booking.total_price;
      existingPayment.platform_fee = booking.platform_fee;
      existingPayment.cook_payout =
        Number(booking.subtotal) - Number(booking.platform_fee);
      existingPayment.status = PaymentStatus.CREATED;
      payment = await this.paymentsRepository.save(existingPayment);
    } else {
      payment = this.paymentsRepository.create({
        booking_id: booking.id,
        amount: booking.total_price,
        platform_fee: booking.platform_fee,
        cook_payout:
          Number(booking.subtotal) - Number(booking.platform_fee),
        razorpay_order_id: razorpayOrder.id,
        status: PaymentStatus.CREATED,
      });
      payment = await this.paymentsRepository.save(payment);
    }

    return {
      payment_id: payment.id,
      razorpay_order_id: razorpayOrder.id,
      razorpay_key: this.configService.get<string>('RAZORPAY_KEY_ID'),
      amount: amountInPaise,
      currency: 'INR',
      booking_id: booking.id,
    };
  }

  // ─── VERIFY PAYMENT ───────────────────────────────────
  // On successful verification: payment → CAPTURED, booking → CONFIRMED,
  // customer + chef notified. This is the ONLY path that flips a booking
  // to CONFIRMED in the new flow.
  async verifyPayment(userId: string, dto: VerifyPaymentDto) {
    const payment = await this.paymentsRepository.findOne({
      where: {
        booking_id: dto.booking_id,
        razorpay_order_id: dto.razorpay_order_id,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    // Verify HMAC signature
    const secret = this.configService.get<string>('RAZORPAY_KEY_SECRET');
    if (!secret) {
      // Misconfigured environments must fail loud, not silently
      // accept any signature. The auth controller's @Public()
      // /payments/verify route would otherwise be exploitable.
      this.logger.error('RAZORPAY_KEY_SECRET is not configured');
      throw new BadRequestException('Payment verification is not configured');
    }
    const body = dto.razorpay_order_id + '|' + dto.razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    if (expectedSignature !== dto.razorpay_signature) {
      payment.status = PaymentStatus.FAILED;
      await this.paymentsRepository.save(payment);
      throw new BadRequestException('Payment verification failed');
    }

    // Double-check with Razorpay: only trust payments in "captured" state
    try {
      const rpPayment = await this.razorpay.payments.fetch(dto.razorpay_payment_id);
      if (rpPayment.status !== 'captured') {
        this.logger.warn(
          `Payment ${dto.razorpay_payment_id} signature ok but status is ${rpPayment.status} — refusing to confirm`,
        );
        // Don't mark as FAILED — may still capture; just refuse to confirm now.
        throw new BadRequestException(
          `Payment is still "${rpPayment.status}" at Razorpay. Please retry in a minute.`,
        );
      }
    } catch (err) {
      // If Razorpay fetch itself fails (network, etc) we still honor signature
      // to avoid blocking legit captures, but log it.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Razorpay fetch failed for ${dto.razorpay_payment_id}: ${msg}`);
    }

    // Mark payment captured
    payment.razorpay_payment_id = dto.razorpay_payment_id;
    payment.razorpay_signature = dto.razorpay_signature;
    payment.status = PaymentStatus.CAPTURED;
    payment.paid_at = new Date();
    await this.paymentsRepository.save(payment);

    // Fetch booking and flip to CONFIRMED
    const booking = await this.bookingsRepository.findOne({
      where: { id: dto.booking_id },
      relations: ['user', 'cook', 'cook.user'],
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // Only flip if not already confirmed/in-progress/completed.
    // Under the new flow (May 29, 2026) most bookings are already
    // CONFIRMED at the time of payment — chef-accept now goes straight
    // there without a separate AWAITING_PAYMENT stage. AWAITING_PAYMENT
    // is kept here for legacy rows that were created before the cutover.
    const flippableFrom = [
      BookingStatus.AWAITING_PAYMENT,
      BookingStatus.PENDING, // legacy
    ];
    if (flippableFrom.includes(booking.status)) {
      booking.status = BookingStatus.CONFIRMED;
      booking.confirmed_at = new Date();
      await this.bookingsRepository.save(booking);

      // Notify customer + chef on the actual state flip — only legacy
      // rows go down this path now.
      this.notificationsService
        .notifyBookingConfirmed(
          booking.user_id,
          booking.id,
          booking.cook?.user?.name || 'Your chef',
        )
        .catch((): void => undefined);
      if (booking.cook?.user_id) {
        this.notificationsService
          .notifyPaymentReceived(booking.cook.user_id, Number(payment.amount))
          .catch((): void => undefined);
      }
    } else if (
      booking.status === BookingStatus.CONFIRMED ||
      booking.status === BookingStatus.IN_PROGRESS
    ) {
      // New-flow case: booking was already CONFIRMED (or even IN_PROGRESS
      // if the customer paid mid-session) before the customer paid. No
      // status flip; just notify the chef that the money landed so they
      // can close out the session via verifyEndOtp.
      if (booking.cook?.user_id) {
        this.notificationsService
          .notifyPaymentReceived(booking.cook.user_id, Number(payment.amount))
          .catch((): void => undefined);
      }
    }

    return {
      message: 'Payment verified successfully',
      payment_id: payment.id,
      booking_id: dto.booking_id,
    };
  }

  // ─── RAZORPAY WEBHOOK ─────────────────────────────────
  /**
   * Verify and dispatch a Razorpay webhook.
   *
   * Security posture (Round 2 hardening):
   *   1. Fail fast if RAZORPAY_WEBHOOK_SECRET env is unset — without it
   *      every webhook would otherwise be implicitly trusted.
   *   2. Fail fast if the signature header is missing.
   *   3. HMAC over the RAW request bytes (Buffer), not JSON.stringify of
   *      the parsed body — the parsed-then-stringified version often
   *      doesn't match what Razorpay signed (whitespace, key order,
   *      escaped Unicode).
   *   4. Constant-time comparison via crypto.timingSafeEqual to neuter
   *      length-leak / timing attacks.
   */
  async handleWebhook(rawBody: Buffer | undefined, body: any, signature: string) {
    const secret = this.configService.get<string>('RAZORPAY_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('RAZORPAY_WEBHOOK_SECRET is not configured');
      throw new BadRequestException('Webhook is not configured');
    }
    if (!signature) {
      throw new BadRequestException('Missing webhook signature');
    }
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException('Empty webhook body');
    }

    const expectedHex = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    // Both sides must be the same length before timingSafeEqual,
    // otherwise it throws (which is itself a timing leak). Pad to the
    // larger length so a length mismatch returns false in constant time.
    const a = Buffer.from(expectedHex, 'utf8');
    const b = Buffer.from(signature || '', 'utf8');
    const lengthsMatch = a.length === b.length;
    const bytesMatch = lengthsMatch && crypto.timingSafeEqual(a, b);
    if (!bytesMatch) {
      this.logger.warn('Invalid webhook signature');
      throw new BadRequestException('Invalid webhook signature');
    }

    const event = body?.event;
    const payload = body?.payload;

    this.logger.log(`Razorpay webhook: ${event}`);

    switch (event) {
      case 'payment.captured':
        await this.handlePaymentCaptured(payload);
        break;
      case 'payment.failed':
        await this.handlePaymentFailed(payload);
        break;
      case 'refund.processed':
        await this.handleRefundProcessed(payload);
        break;
      default:
        this.logger.log(`Unhandled webhook event: ${event}`);
    }

    return { status: 'ok' };
  }

  // ─── PROCESS REFUND ───────────────────────────────────
  async processRefund(bookingId: string, amount: number) {
    const payment = await this.paymentsRepository.findOne({
      where: { booking_id: bookingId, status: PaymentStatus.CAPTURED },
    });

    if (!payment) {
      throw new NotFoundException('No captured payment found for this booking');
    }

    const amountInPaise = Math.round(amount * 100);

    if (!payment.razorpay_payment_id) {
      // The CAPTURED-status filter on findOne() above means this is
      // genuinely unexpected — a captured payment without a payment id
      // would be data corruption. Fail loud rather than passing
      // garbage to the SDK.
      throw new BadRequestException(
        'Captured payment is missing razorpay_payment_id; cannot refund',
      );
    }

    try {
      // The razorpay-node SDK's `refund()` overload returns
      // `Promise<RazorpayRefund> | void` depending on whether a
      // callback is passed. We don't pass one, so cast to the async
      // overload's resolved type.
      const refund = (await this.razorpay.payments.refund(
        payment.razorpay_payment_id,
        {
          amount: amountInPaise,
          notes: { booking_id: bookingId, reason: 'Cancellation refund' },
        },
      )) as { id: string };

      payment.status = PaymentStatus.REFUNDED;
      payment.refund_id = refund.id;
      payment.refund_amount = amount;
      payment.refunded_at = new Date();
      await this.paymentsRepository.save(payment);

      return { refund_id: refund.id, amount };
    } catch (error) {
      this.logger.error('Refund failed', error);
      throw new BadRequestException('Refund processing failed');
    }
  }

  async getPaymentByBooking(bookingId: string) {
    return this.paymentsRepository.findOne({
      where: { booking_id: bookingId },
    });
  }

  // ═══ PRIVATE WEBHOOK HANDLERS ═════════════════════════

  private async handlePaymentCaptured(payload: any) {
    const orderId = payload.payment?.entity?.order_id;
    if (!orderId) return;

    const payment = await this.paymentsRepository.findOne({
      where: { razorpay_order_id: orderId },
    });

    if (payment && payment.status !== PaymentStatus.CAPTURED) {
      payment.status = PaymentStatus.CAPTURED;
      payment.razorpay_payment_id = payload.payment?.entity?.id;
      payment.paid_at = new Date();
      await this.paymentsRepository.save(payment);

      // Also flip booking to CONFIRMED if not already (webhook redundancy)
      const booking = await this.bookingsRepository.findOne({
        where: { id: payment.booking_id },
        relations: ['user', 'cook', 'cook.user'],
      });
      if (booking && (
        booking.status === BookingStatus.AWAITING_PAYMENT ||
        booking.status === BookingStatus.PENDING
      )) {
        booking.status = BookingStatus.CONFIRMED;
        booking.confirmed_at = new Date();
        await this.bookingsRepository.save(booking);
        this.notificationsService
          .notifyBookingConfirmed(
            booking.user_id,
            booking.id,
            booking.cook?.user?.name || 'Your chef',
          )
          .catch((): void => undefined);
      }
    }
  }

  private async handlePaymentFailed(payload: any) {
    const orderId = payload.payment?.entity?.order_id;
    if (!orderId) return;

    const payment = await this.paymentsRepository.findOne({
      where: { razorpay_order_id: orderId },
    });

    if (payment) {
      payment.status = PaymentStatus.FAILED;
      await this.paymentsRepository.save(payment);
    }
  }

  private async handleRefundProcessed(payload: any) {
    const paymentId = payload.refund?.entity?.payment_id;
    if (!paymentId) return;

    const payment = await this.paymentsRepository.findOne({
      where: { razorpay_payment_id: paymentId },
    });

    if (payment) {
      payment.status = PaymentStatus.REFUNDED;
      payment.refunded_at = new Date();
      await this.paymentsRepository.save(payment);
    }
  }
}
