import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  async getMyNotifications(
    @CurrentUser() user: User,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.notificationsService.getUserNotifications(
      user.id,
      page || 1,
      limit || 20,
    );
  }

  @Patch(':id/read')
  async markAsRead(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markAsRead(user.id, id);
  }

  @Patch('read-all')
  async markAllRead(@CurrentUser() user: User) {
    return this.notificationsService.markAllRead(user.id);
  }

  /**
   * Round 4 / Analytics Phase 2 — CTR tracking.
   * Fired when the user actually opens / taps the notification (not
   * the same as bulk "mark all read"). The service writes the
   * `clicked_at` timestamp and emits a `notification_clicked` analytics
   * event so the admin dashboard can compute click-through rate per
   * broadcast.
   */
  @Post(':id/click')
  async recordClick(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.recordClick(user.id, id);
  }
}
