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
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { CreateSubscriptionDto } from './dto/subscription.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User, UserRole } from '../users/user.entity';

@ApiTags('Subscriptions')
@ApiBearerAuth('access-token')
@Controller('subscriptions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  // ─── CUSTOMER ────────────────────────────────────────
  @Post()
  @Throttle({ strict: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Create a recurring meal-plan subscription' })
  async create(@CurrentUser() user: User, @Body() dto: CreateSubscriptionDto) {
    return this.subscriptionsService.create(user.id, dto);
  }

  @Get('me')
  @ApiOperation({ summary: 'My subscriptions' })
  async mine(@CurrentUser() user: User) {
    return this.subscriptionsService.listForUser(user.id);
  }

  @Patch(':id/pause')
  async pause(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptionsService.pause(id, user.id);
  }

  @Patch(':id/resume')
  async resume(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptionsService.resume(id, user.id);
  }

  @Patch(':id/cancel')
  async cancel(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.subscriptionsService.cancel(id, user.id);
  }

  // ─── CHEF ────────────────────────────────────────────
  @Get('cook/me')
  @ApiOperation({ summary: 'Chef — my active recurring commitments' })
  async cookCommitments(@CurrentUser() user: User) {
    return this.subscriptionsService.listForCookUser(user.id);
  }

  // ─── ADMIN ───────────────────────────────────────────
  @Get('admin')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — all subscriptions' })
  async adminList(@Query('page') page = 1, @Query('limit') limit = 20) {
    return this.subscriptionsService.adminList(Number(page), Number(limit));
  }
}
