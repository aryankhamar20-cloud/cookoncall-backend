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
  // NEW FLOW: payment can only be initiated for bookings in AWAITING_PAYMENT.
  // Legacy rows still in PENDING are tolerated to keep old bookings payable,
  // but all new bookings must come via the accept flow.
  async createOrder(userId: string, dto: CreateOrderDto) {
    const booking = await this.bookingsRepository.findOne({
      where: { id: dto.booking_id, user_id: userId },
      relations: ['cook', 'cook.user'],
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    const payableStatuses = [
      BookingStatus.AWAITING_PAYMENT,
      BookingStatus.PENDING, // legacy
    ];
    if (!payableStatuses.includes(booking.status)) {
      throw new BadRequestException(
        `This booking cannot be paid right now (status: ${booking.status})`,
      );
    }

    // Reject expired AWAITING_PAYMENT bookings (3h payment window)
    if (booking.status === BookingStatus.AWAITING_PAYMENT && booking.payment_expires_at) {
      if (new Date() > new Date(booking.payment_expires_at)) {
        throw new BadRequestException(
          'Your 3-hour payment window has expired. Please book again.',
        );
      }
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
      this.logger.error(
        `Razorpay order creation failed: ${error?.message || JSON.stringify(error)}`,
      );
      this.logger.error(
        `Razorpay error details: statusCode=${error?.statusCode}, error=${JSON.stringify(error?.error)}`,
      );
      throw new BadRequestException(
        `Payment gateway error: ${error?.error?.description || error?.message || 'Unknown error'}`,
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
      this.logger.warn(`Razorpay fetch failed for ${dto.razorpay_payment_id}: ${err?.message || err}`);
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

    // Only flip if not already confirmed/in-progress/completed
    const flippableFrom = [
      BookingStatus.AWAITING_PAYMENT,
      BookingStatus.PENDING, // legacy
    ];
    if (flippableFrom.includes(booking.status)) {
      booking.status = BookingStatus.CONFIRMED;
      booking.confirmed_at = new Date();
      await this.bookingsRepository.save(booking);

      // Notify customer + chef
      this.notificationsService
        .notifyBookingConfirmed(
          booking.user_id,
          booking.id,
          booking.cook?.user?.name || 'Your chef',
        )
        .catch(() => undefined);
      if (booking.cook?.user_id) {
        this.notificationsService
          .notifyPaymentReceived(booking.cook.user_id, Number(payment.amount))
          .catch(() => undefined);
      }
    }

    return {
      message: 'Payment verified successfully',
      payment_id: payment.id,
      booking_id: dto.booking_id,
    };
  }

  // ─── RAZORPAY WEBHOOK ─────────────────────────────────
  async handleWebhook(body: any, signature: string) {
    const secret = this.configService.get<string>('RAZORPAY_WEBHOOK_SECRET');

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(body))
      .digest('hex');

    if (expectedSignature !== signature) {
      this.logger.warn('Invalid webhook signature');
      throw new BadRequestException('Invalid webhook signature');
    }

    const event = body.event;
    const payload = body.payload;

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

    try {
      const refund = await this.razorpay.payments.refund(
        payment.razorpay_payment_id,
        {
          amount: amountInPaise,
          notes: { booking_id: bookingId, reason: 'Cancellation refund' },
        },
      );

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
          .catch(() => undefined);
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
