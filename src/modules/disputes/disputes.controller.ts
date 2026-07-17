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
import { DisputesService } from './disputes.service';
import { CreateDisputeDto, ResolveDisputeDto } from './dto/dispute.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User, UserRole } from '../users/user.entity';
import { DisputeStatus } from './dispute.entity';

@ApiTags('Disputes')
@ApiBearerAuth('access-token')
@Controller('disputes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  // ─── CUSTOMER / CHEF: raise + view own ───────────────
  @Post()
  @Throttle({ strict: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Report an issue on a booking' })
  async raise(@CurrentUser() user: User, @Body() dto: CreateDisputeDto) {
    return this.disputesService.raise(user.id, dto);
  }

  @Get('me')
  @ApiOperation({ summary: 'Disputes I raised' })
  async mine(@CurrentUser() user: User) {
    return this.disputesService.listForUser(user.id);
  }

  // ─── ADMIN ───────────────────────────────────────────
  @Get('admin')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — dispute queue' })
  async adminList(
    @Query('status') status?: DisputeStatus,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    return this.disputesService.adminList(status, Number(page), Number(limit));
  }

  @Patch('admin/:id/resolve')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — resolve / reject / review a dispute' })
  async resolve(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.disputesService.resolve(id, admin.id, dto);
  }
}
