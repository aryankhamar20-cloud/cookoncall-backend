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
  ) {
    this.razorpay = new (Razorpay as any)({
      key_id: this.configService.get<string>('RAZORPAY_KEY_ID'),
      key_secret: this.configService.get<string>('RAZORPAY_KEY_SECRET'),
    });
  }

  // ─── CREATE RAZORPAY ORDER ────────────────────────────
  async createOrder(userId: string, dto: CreateOrderDto) {
    const booking = await this.bookingsRepository.findOne({
      where: { id: dto.booking_id, user_id: userId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException('Booking is not in pending state');
    }

    // Check if payment already exists
    const existingPayment = await this.paymentsRepository.findOne({
      where: { booking_id: dto.booking_id },
    });

    if (existingPayment && existingPayment.status === PaymentStatus.CAPTURED) {
      throw new BadRequestException('Payment already completed');
    }

    // Create Razorpay order
    const amountInPaise = Math.round(Number(booking.total_price) * 100);

    const razorpayOrder = await this.razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `booking_${booking.id}`,
      notes: {
        booking_id: booking.id,
        user_id: userId,
      },
    });

    // Create or update payment record
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

    // Verify signature
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

    // Payment verified — update records
    payment.razorpay_payment_id = dto.razorpay_payment_id;
    payment.razorpay_signature = dto.razorpay_signature;
    payment.status = PaymentStatus.CAPTURED;
    payment.paid_at = new Date();
    await this.paymentsRepository.save(payment);

    // Update booking status to CONFIRMED
    await this.bookingsRepository.update(dto.booking_id, {
      status: BookingStatus.CONFIRMED,
      confirmed_at: new Date(),
    });

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

  // ─── GET PAYMENT BY BOOKING ───────────────────────────
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
