import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import {
  CreateBookingDto,
  GetBookingsDto,
  UpdateBookingStatusDto,
  RejectBookingDto,
  RebookDto,
} from './dto/booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  async createBooking(
    @CurrentUser() user: User,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookingsService.createBooking(user.id, dto);
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
      return { message: 'Not authorized to view this booking' };
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

  // ─── CANCELLATION REFUND ESTIMATE ──────────────────────
  // Matches the Apr 19 policy that's enforced by getCancellationRefund():
  //   - 2+ hours before slot: 80% of dish amount (visit fee non-refundable)
  //   - Under 2 hours: no refund
  @Get(':id/refund-estimate')
  async getRefundEstimate(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const booking = await this.bookingsService.findById(id);
    const refund = this.bookingsService.getCancellationRefund(booking);
    const hoursUntil =
      (new Date(booking.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60);

    const policy =
      hoursUntil >= 2
        ? '80% refund of dish amount (visit fee non-refundable)'
        : 'No refund (less than 2 hours before session)';

    return {
      refund_amount: refund,
      total_price: booking.total_price,
      hours_until_session: Math.round(hoursUntil * 10) / 10,
      policy,
    };
  }
}
