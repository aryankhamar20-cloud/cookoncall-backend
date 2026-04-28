import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AreasService } from './areas.service';
import { ApproveAreaDto, RejectAreaDto, RequestAreaDto } from './dto/area.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User, UserRole } from '../users/user.entity';
import { Public } from '../../common/decorators/public.decorator';

@Controller('areas')
export class AreasController {
  constructor(private readonly areasService: AreasService) {}

  // ─── PUBLIC: list active areas ─────────────────────────
  // Customers and chefs both call this to populate dropdowns.
  @Public()
  @Get()
  async list(@Query('city') city?: string) {
    return this.areasService.listActive(city);
  }

  // ─── AUTH: chef/customer requests a new area ──────────
  // Hybrid model: when typed area is not in our list, frontend offers
  // 'request to add' which calls this endpoint. Admin then approves.
  @UseGuards(JwtAuthGuard)
  @Post('request')
  async request(@CurrentUser() user: User, @Body() dto: RequestAreaDto) {
    const role = user.role === UserRole.COOK ? 'cook' : 'customer';
    return this.areasService.requestArea(user.id, role, dto);
  }

  // ─── ADMIN: list/approve/reject area requests ─────────
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/requests')
  async listRequests(@Query('status') status?: 'pending' | 'approved' | 'rejected') {
    return this.areasService.listRequests(status);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('admin/requests/:id/approve')
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
    @Body() dto: ApproveAreaDto,
  ) {
    return this.areasService.approveRequest(id, admin.id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('admin/requests/:id/reject')
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
    @Body() dto: RejectAreaDto,
  ) {
    return this.areasService.rejectRequest(id, admin.id, dto.reason);
  }
}
