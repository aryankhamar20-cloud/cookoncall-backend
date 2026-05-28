import { Body, Controller, Get, Patch } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from './user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { IsString, IsNotEmpty } from 'class-validator';

class UpdateFcmTokenDto {
  @IsString()
  @IsNotEmpty()
  fcm_token: string;
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getProfile(@CurrentUser() user: User) {
    return this.usersService.findById(user.id);
  }

  @Patch('me')
  async updateProfile(
    @CurrentUser() user: User,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.updateProfile(user.id, dto);
  }

  // ✅ P1: FCM token endpoint — called by Flutter app on login/startup
  @Patch('me/fcm-token')
  async updateFcmToken(
    @CurrentUser() user: User,
    @Body() dto: UpdateFcmTokenDto,
  ) {
    return this.usersService.updateFcmToken(user.id, dto.fcm_token);
  }

  @Get('me/stats')
  async getMyStats(@CurrentUser() user: User) {
    return this.usersService.getUserStats(user.id);
  }
}
