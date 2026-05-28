import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { User, UserRole } from '../users/user.entity';
import { IsString, Length } from 'class-validator';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty } from '@nestjs/swagger';

class ApplyReferralDto {
  @ApiProperty({ example: 'COC-A1B2C3' })
  @IsString()
  @Length(6, 15)
  code: string;
}

@ApiTags('Referrals')
@ApiBearerAuth('access-token')
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referralsService: ReferralsService) {}

  @Get('my-code')
  @ApiOperation({ summary: 'Get my referral code and stats' })
  async getMyCode(@CurrentUser() user: User) {
    return this.referralsService.getMyReferralCode(user.id);
  }

  @Post('apply')
  @ApiOperation({ summary: 'Apply a referral code (call once after registration)' })
  async applyCode(
    @CurrentUser() user: User,
    @Body() dto: ApplyReferralDto,
  ) {
    await this.referralsService.applyReferralCode(user.id, dto.code);
    return { message: 'Referral code applied successfully' };
  }

  @Get('admin')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — list all referrals' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.referralsService.findAll(Number(page), Number(limit));
  }
}
