import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminService } from './admin.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User, UserRole } from '../users/user.entity';
import { BookingStatus } from '../bookings/booking.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// Small helper: extracts IP + user-agent from the request for audit logging.
function auditMeta(req: Request) {
  const ipHeader =
    (req.headers['x-forwarded-for'] as string) ||
    (req.headers['cf-connecting-ip'] as string) ||
    '';
  const ip = ipHeader.split(',')[0].trim() || req.ip || null;
  const userAgent = (req.headers['user-agent'] as string) || null;
  return { ip, userAgent };
}

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── DASHBOARD ───────────────────────────────────────
  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  @Get('recent-users')
  async getRecentUsers() {
    return this.adminService.getRecentUsers();
  }

  @Get('recent-bookings')
  async getRecentBookings() {
    return this.adminService.getRecentBookings();
  }

  // ─── AUDIT LOG (read-only, admin-only) ───────────────
  @Get('audit-log')
  async getAuditLog(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('action') action?: string,
    @Query('target_type') targetType?: string,
  ) {
    return this.adminService.getAuditLog(
      page || 1,
      limit || 50,
      action,
      targetType,
    );
  }

  // ─── USERS ───────────────────────────────────────────
  @Get('users')
  async getUsers(
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getUsers(search, page || 1, limit || 20);
  }

  @Patch('users/:id/toggle-active')
  async toggleUserActive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.adminService.toggleUserActive(id, admin, auditMeta(req));
  }

  @Patch('users/:id')
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string; email?: string; phone?: string; role?: string },
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.adminService.updateUser(id, body, admin, auditMeta(req));
  }

  @Delete('users/:id')
  async deleteUser(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.adminService.deleteUser(id, admin, auditMeta(req));
  }

  // ─── COOKS ───────────────────────────────────────────
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

  /** Get cooks with pending verification — for admin review panel */
  @Get('cooks/pending')
  async getPendingVerifications(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getPendingVerifications(page || 1, limit || 20);
  }

  @Patch('cooks/:id/verify')
  async verifyCook(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { verified: boolean; rejection_reason?: string },
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.adminService.verifyCook(
      id,
      body.verified,
      body.rejection_reason,
      admin,
      auditMeta(req),
    );
  }

  @Delete('cooks/:id')
  async deleteCook(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.adminService.deleteCook(id, admin, auditMeta(req));
  }

  // ─── BOOKINGS ────────────────────────────────────────
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
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.adminService.updateBookingStatus(
      id,
      status,
      admin,
      auditMeta(req),
    );
  }

  @Delete('bookings/:id')
  async deleteBooking(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.adminService.deleteBooking(id, admin, auditMeta(req));
  }
}
