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

    // Ensure user is part of this booking
    const isCookOwner =
      booking.cook?.user_id === user.id;
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

  @Get(':id/refund-estimate')
  async getRefundEstimate(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const booking = await this.bookingsService.findById(id);
    const refund = this.bookingsService.getCancellationRefund(booking);
    return { refund_amount: refund, total_price: booking.total_price };
  }
}
