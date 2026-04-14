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

    return booking;
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

  /** Chef clicks "Start Cooking" → sends OTP to customer */
  @Post(':id/start-otp')
  async sendStartOtp(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.sendStartOtp(id, user.id);
  }

  /** Chef enters the start OTP customer gave them */
  @Post(':id/verify-start-otp')
  async verifyStartOtp(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('otp') otp: string,
  ) {
    return this.bookingsService.verifyStartOtp(id, user.id, otp);
  }

  /** Chef clicks "End Session" → sends OTP to customer */
  @Post(':id/end-otp')
  async sendEndOtp(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bookingsService.sendEndOtp(id, user.id);
  }

  /** Chef enters the end OTP → session complete */
  @Post(':id/verify-end-otp')
  async verifyEndOtp(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('otp') otp: string,
  ) {
    return this.bookingsService.verifyEndOtp(id, user.id, otp);
  }

  // ─── CANCELLATION REFUND ESTIMATE ──────────────────────
  @Get(':id/refund-estimate')
  async getRefundEstimate(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const booking = await this.bookingsService.findById(id);
    const refund = this.bookingsService.getCancellationRefund(booking);
    const hoursUntil =
      (new Date(booking.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60);

    let policy: string;
    if (hoursUntil >= 4) {
      policy = 'Full refund (4+ hours before session)';
    } else if (hoursUntil >= 2) {
      policy = '50% refund (2-4 hours before session)';
    } else {
      policy = 'No refund (less than 2 hours before session)';
    }

    return {
      refund_amount: refund,
      total_price: booking.total_price,
      hours_until_session: Math.round(hoursUntil * 10) / 10,
      policy,
    };
  }
}
