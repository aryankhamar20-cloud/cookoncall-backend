import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { BookingsService } from './bookings.service';
import { ReceiptService } from './receipt.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import {
  CreateBookingDto,
  GetBookingsDto,
  UpdateBookingStatusDto,
  RejectBookingDto,
  RebookDto,
  RescheduleBookingDto,
} from './dto/booking.dto';
import { BookingStatus } from './booking.entity';

@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookingsService: BookingsService,
    private readonly receiptService: ReceiptService,
    private readonly notificationsService: NotificationsService,
  ) {}

  @Post()
  async createBooking(
    @CurrentUser() user: User,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookingsService.createBooking(user.id, dto);
  }

  // Customer reschedules their booking to a new time (web + app).
  @Patch(':id/reschedule')
  async reschedule(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleBookingDto,
  ) {
    return this.bookingsService.reschedule(id, user.id, dto.scheduled_at);
  }

  @Get()
  async getMyBookings(
    @CurrentUser() user: User,
    @Query() dto: GetBookingsDto,
  ) {
    return this.bookingsService.getUserBookings(user.id, dto);
  }

  @Get('cook')
  async getMyCookBookings(
    @CurrentUser() user: User,
    @Query() dto: GetBookingsDto,
  ) {
    return this.bookingsService.getCookBookings(user.id, dto);
  }

  @Get(':id')
  async getBooking(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const booking = await this.bookingsService.findById(id);

    const isCookOwner = booking.cook?.user_id === user.id;
    const isUserOwner = booking.user_id === user.id;
    const isAdmin = user.role === 'admin';

    if (!isUserOwner && !isCookOwner && !isAdmin) {
      // Used to return 200 with a benign message — that's both a
      // UX bug (clients couldn't distinguish "no permission" from
      // "success with no data") and an inconsistency with the
      // `/receipt` endpoint below, which correctly throws 403.
      throw new ForbiddenException('Not authorised to view this booking');
    }

    // Customer view strips internal-only fields like rejection_reason.
    if (isUserOwner && !isAdmin) {
      return this.bookingsService.findByIdForCustomer(id);
    }
    return booking;
  }

  // ─── NEW FLOW: CHEF ACCEPT / REJECT ───────────────────

  /** Chef accepts the booking → status becomes AWAITING_PAYMENT */
  @Post(':id/accept')
  async acceptBooking(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.acceptBooking(id, user.id);
  }

  /**
   * Chef rejects the booking with a reason.
   * Reason is stored internally and NEVER returned to customer endpoints.
   */
  @Post(':id/reject')
  async rejectBooking(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectBookingDto,
  ) {
    return this.bookingsService.rejectBooking(id, user.id, dto);
  }

  /** Customer rebooks with a different chef after rejection/expiry */
  @Post(':id/rebook')
  async rebook(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RebookDto,
  ) {
    return this.bookingsService.rebookWithDifferentChef(id, user.id, dto);
  }

  @Patch(':id/status')
  async updateStatus(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBookingStatusDto,
  ) {
    return this.bookingsService.updateStatus(id, user.id, user.role, dto);
  }

  // ─── COOKING SESSION OTP ENDPOINTS ─────────────────────

  @Post(':id/start-otp')
  async sendStartOtp(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.sendStartOtp(id, user.id);
  }

  @Post(':id/verify-start-otp')
  async verifyStartOtp(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('otp') otp: string,
  ) {
    return this.bookingsService.verifyStartOtp(id, user.id, otp);
  }

  @Post(':id/end-otp')
  async sendEndOtp(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.sendEndOtp(id, user.id);
  }

  @Post(':id/verify-end-otp')
  async verifyEndOtp(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('otp') otp: string,
  ) {
    return this.bookingsService.verifyEndOtp(id, user.id, otp);
  }

  // ─── COOK-ONLY: CUSTOMER CONTACT POST-CONFIRMATION ─────
  /**
   * Returns the customer's phone number to the assigned cook once the
   * booking is paid / confirmed. Pre-confirmation, this returns 403 to
   * stop cooks from bypassing the platform on free leads.
   */
  @Get(':id/customer-phone')
  async getCustomerPhone(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.getCustomerPhoneForCook(id, user.id);
  }

  // ─── PDF RECEIPT (Round 2 — H4) ───────────────────────
  /**
   * Streams a PDF receipt for a paid booking.
   *
   * Authorization: caller must be the booking's customer OR the
   * assigned cook OR an admin. Pre-payment states (pending_chef_approval,
   * awaiting_payment, cancelled before payment) return 403 — there's
   * nothing meaningful to receipt yet.
   *
   * Bypasses the global TransformInterceptor by returning the response
   * directly via @Res() so the binary PDF reaches the client unwrapped.
   */
  @Get(':id/receipt')
  @Header('Content-Type', 'application/pdf')
  async getReceipt(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const booking = await this.bookingsService.findById(id);
    if (!booking) throw new NotFoundException('Booking not found');

    const cook = booking.cook;
    const isOwner =
      booking.user_id === user.id ||
      cook?.user_id === user.id ||
      user.role === 'admin';
    if (!isOwner) {
      throw new ForbiddenException('Not authorised to download this receipt');
    }

    const eligible: BookingStatus[] = [
      BookingStatus.CONFIRMED,
      BookingStatus.IN_PROGRESS,
      BookingStatus.COMPLETED,
      BookingStatus.PENDING, // legacy
    ];
    if (!eligible.includes(booking.status)) {
      throw new ForbiddenException(
        'Receipts are available only after the booking is paid / confirmed',
      );
    }

    const buf = await this.receiptService.generate(booking);
    const fileName = this.receiptService.fileName(booking);
    res.set('Content-Disposition', `attachment; filename="${fileName}"`);
    res.set('Content-Length', String(buf.length));
    res.status(HttpStatus.OK).send(buf);
  }

  // ─── EMAIL THE INVOICE (P6.2) ─────────────────────────
  /**
   * Generates the invoice PDF and emails it to the booking's customer as
   * an attachment (via Brevo). Same authorization + eligibility rules as
   * the download endpoint. Returns the masked recipient so the client can
   * confirm where it went.
   */
  @Post(':id/receipt/email')
  // Anti-abuse: prevents inbox spamming a customer and protects our Brevo
  // send quota — 5 invoice emails per minute per IP is plenty.
  @Throttle({ strict: { ttl: 60000, limit: 5 } })
  async emailReceipt(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const booking = await this.bookingsService.findById(id);
    if (!booking) throw new NotFoundException('Booking not found');

    const cook = booking.cook;
    const isOwner =
      booking.user_id === user.id ||
      cook?.user_id === user.id ||
      user.role === 'admin';
    if (!isOwner) {
      throw new ForbiddenException('Not authorised to email this invoice');
    }

    const eligible: BookingStatus[] = [
      BookingStatus.CONFIRMED,
      BookingStatus.IN_PROGRESS,
      BookingStatus.COMPLETED,
      BookingStatus.PENDING, // legacy
    ];
    if (!eligible.includes(booking.status)) {
      throw new ForbiddenException(
        'Invoices are available only after the booking is paid / confirmed',
      );
    }

    // Always deliver to the customer of record.
    const recipient = booking.user?.email;
    if (!recipient) {
      throw new NotFoundException('No email address on file for this booking');
    }

    const buf = await this.receiptService.generate(booking);
    const invoiceNo = this.receiptService.invoiceNumber(booking);
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#3D2418;">
        <h2 style="color:#E8520A;margin:0 0 8px;">Your CookOnCall invoice</h2>
        <p style="font-size:14px;line-height:1.6;">
          Hi ${booking.user?.name || 'there'},<br/>
          Your invoice <strong>${invoiceNo}</strong> is attached as a PDF.
          Thank you for using CookOnCall!
        </p>
        <p style="font-size:12px;color:#8B7355;">
          Questions? Reply to this email or reach us at support@thecookoncall.com.
        </p>
      </div>`;

    const sent = await this.notificationsService.sendEmailWithAttachment(
      recipient,
      `CookOnCall Invoice ${invoiceNo}`,
      html,
      { name: this.receiptService.fileName(booking), content: buf },
    );

    if (!sent) {
      throw new ServiceUnavailableException(
        'Email service is not configured or the send failed. Please try again later.',
      );
    }

    // Mask the recipient (a***@domain) so the response doesn't leak the
    // full address to a cook/admin who triggered it.
    const masked = recipient.replace(/^(.).*(@.*)$/, '$1***$2');
    return { message: `Invoice ${invoiceNo} emailed to ${masked}` };
  }

  // ─── CANCELLATION REFUND ESTIMATE ──────────────────────
  // Refund Policy v2 (Apr 26 LOCKED) — Option B: % on TOTAL, platform absorbs chef comp
  //   ≥24h: 100% refund / chef ₹0
  //   ≥8h:   75% refund / chef ₹25
  //   ≥4h:   50% refund / chef ₹50
  //   ≥2h:   25% refund / chef ₹75
  //   <2h:    0% refund / chef ₹100
  @Get(':id/refund-estimate')
  async getRefundEstimate(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const booking = await this.bookingsService.findById(id);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // Defense-in-depth: previously this route accepted any authenticated
    // user. The estimate exposes total_price + policy text, which is
    // booking-private data. Practical exploit was gated by UUID entropy
    // (122 bits) but it was still a real privacy gap. Lock it down to
    // the booking's customer / assigned cook / admin — same authz
    // rule used by /receipt and /:id above.
    const isUserOwner = booking.user_id === user.id;
    const isCookOwner = booking.cook?.user_id === user.id;
    const isAdmin = user.role === 'admin';
    if (!isUserOwner && !isCookOwner && !isAdmin) {
      throw new ForbiddenException(
        'Not authorised to view this booking',
      );
    }

    const { refund, chefCompensation } =
      this.bookingsService.getCancellationRefund(booking);
    const hoursUntil =
      (new Date(booking.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60);

    let policy: string;
    if (hoursUntil >= 24) policy = '100% refund — full amount returned';
    else if (hoursUntil >= 8) policy = '75% refund (chef receives ₹25 compensation)';
    else if (hoursUntil >= 4) policy = '50% refund (chef receives ₹50 compensation)';
    else if (hoursUntil >= 2) policy = '25% refund (chef receives ₹75 compensation)';
    else policy = 'No refund — under 2 hours before session (chef receives ₹100)';

    return {
      refund_amount: refund,
      chef_cancellation_fee: chefCompensation,
      total_price: booking.total_price,
      hours_until_session: Math.round(hoursUntil * 10) / 10,
      policy,
    };
  }
}
