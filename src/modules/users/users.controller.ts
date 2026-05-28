import { Body, Controller, Get, Patch } from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateFcmTokenDto } from './dto/update-fcm-token.dto';
import { UpdateNotificationPreferencesDto } from './dto/notification-preferences.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from './user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@CurrentUser() user: User) {
    return this.usersService.findById(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update current user profile' })
  async updateProfile(
    @CurrentUser() user: User,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Get('me/stats')
  @ApiOperation({ summary: 'Get current user booking stats' })
  async getMyStats(@CurrentUser() user: User) {
    return this.usersService.getUserStats(user.id);
  }

  @Patch('me/fcm-token')
  @ApiOperation({ summary: 'Update FCM push notification token' })
  async updateFcmToken(
    @CurrentUser() user: User,
    @Body() dto: UpdateFcmTokenDto,
  ) {
    return this.usersService.updateFcmToken(user.id, dto.fcm_token);
  }

  // ─── ROUND 4: NOTIFICATION PREFERENCES ──────────────────
  @Get('me/notification-preferences')
  @ApiOperation({ summary: 'Get current user notification channel preferences' })
  async getNotificationPreferences(@CurrentUser() user: User) {
    return this.usersService.getNotificationPreferences(user.id);
  }

  @Patch('me/notification-preferences')
  @ApiOperation({ summary: 'Update current user notification channel preferences' })
  async updateNotificationPreferences(
    @CurrentUser() user: User,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.usersService.updateNotificationPreferences(user.id, dto);
  }
}
