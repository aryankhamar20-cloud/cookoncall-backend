import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/user.entity';
import { BookingStatus } from '../bookings/booking.entity';

@Controller('admin')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  @Get('users')
  async getUsers(
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getUsers(search, page || 1, limit || 20);
  }

  @Get('cooks')
  async getCooks(
    @Query('verified') verified?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const isVerified =
      verified === 'true' ? true : verified === 'false' ? false : undefined;
    return this.adminService.getCooks(isVerified, page || 1, limit || 20);
  }

  @Patch('cooks/:id/verify')
  async verifyCook(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('verified') verified: boolean,
  ) {
    return this.adminService.verifyCook(id, verified);
  }

  @Patch('users/:id/toggle-active')
  async toggleUserActive(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.toggleUserActive(id);
  }

  @Get('bookings')
  async getBookings(
    @Query('status') status?: BookingStatus,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getBookings(
      status,
      search,
      page || 1,
      limit || 20,
    );
  }

  @Patch('bookings/:id/status')
  async updateBookingStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: BookingStatus,
  ) {
    return this.adminService.updateBookingStatus(id, status);
  }

  @Get('recent-users')
  async getRecentUsers() {
    return this.adminService.getRecentUsers();
  }

  @Get('recent-bookings')
  async getRecentBookings() {
    return this.adminService.getRecentBookings();
  }
}
