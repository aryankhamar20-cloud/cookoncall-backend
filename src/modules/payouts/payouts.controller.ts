import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { PayoutsService } from './payouts.service';
import { CreatePayoutDto, MarkPayoutPaidDto } from './dto/payout.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User, UserRole } from '../users/user.entity';

@ApiTags('Payouts')
@ApiBearerAuth('access-token')
@Controller('payouts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}

  // ─── CHEF: my payout history ─────────────────────────
  @Get('me')
  @ApiOperation({ summary: 'Chef — my payout settlement history' })
  async myPayouts(@CurrentUser() user: User) {
    return this.payoutsService.listForCookUser(user.id);
  }

  // ─── ADMIN: outstanding balances per chef ────────────
  @Get('admin/balances')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — outstanding balance for every chef' })
  async balances() {
    return this.payoutsService.allBalances();
  }

  // ─── ADMIN: recent payout records ────────────────────
  @Get('admin')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — recent payout records' })
  async adminList(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.payoutsService.adminList(Number(page), Number(limit));
  }

  // ─── ADMIN: record a payout ──────────────────────────
  @Post('admin')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — record a payout to a chef' })
  async create(@CurrentUser() admin: User, @Body() dto: CreatePayoutDto) {
    return this.payoutsService.create(admin.id, dto);
  }

  // ─── ADMIN: mark a pending payout paid ───────────────
  @Patch('admin/:id/mark-paid')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — mark a payout as paid' })
  async markPaid(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkPayoutPaidDto,
  ) {
    return this.payoutsService.markPaid(id, dto);
  }
}
