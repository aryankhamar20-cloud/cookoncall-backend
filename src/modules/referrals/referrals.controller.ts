import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { User, UserRole } from '../users/user.entity';

@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referralsService: ReferralsService) {}

  // ─── CUSTOMER ─────────────────────────────────────────

  /** Get current user's referral code + stats */
  @Get('my-code')
  async getMyCode(@CurrentUser() user: User) {
    return this.referralsService.getReferralCode(user.id);
  }

  /** Get full referral stats for current user */
  @Get('my-stats')
  async getMyStats(@CurrentUser() user: User) {
    return this.referralsService.getUserReferralStats(user.id);
  }

  // ─── ADMIN ───────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async getAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.referralsService.getAllReferrals(page || 1, limit || 20);
  }
}
