import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AvailabilityService, Slot } from './availability.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Public } from '../../common/decorators/public.decorator';
import { User, UserRole } from '../users/user.entity';
import {
  UpsertScheduleDto,
  UpsertOverrideDto,
  UpdateAvailabilitySettingsDto,
} from './dto/availability.dto';

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly svc: AvailabilityService) {}

  // ─── CHEF ──────────────────────────────────────────────
  @Get('me')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async getMine(@CurrentUser() user: User) {
    return this.svc.getMyAvailability(user.id);
  }

  @Post('me/schedule')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async upsertSchedule(
    @CurrentUser() user: User,
    @Body() dto: UpsertScheduleDto,
  ) {
    return this.svc.upsertSchedule(user.id, dto);
  }

  @Post('me/override')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async upsertOverride(
    @CurrentUser() user: User,
    @Body() dto: UpsertOverrideDto,
  ) {
    return this.svc.upsertOverride(user.id, dto);
  }

  @Delete('me/override/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async deleteOverride(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.deleteOverride(user.id, id);
  }

  @Patch('me/settings')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async updateSettings(
    @CurrentUser() user: User,
    @Body() dto: UpdateAvailabilitySettingsDto,
  ) {
    return this.svc.updateSettings(user.id, dto);
  }

  // ─── PUBLIC: customer-facing slot picker ──────────────
  @Public()
  @Get('cook/:id/slots')
  async getSlots(
    @Param('id', ParseUUIDPipe) cookId: string,
    @Query('date') date: string,
    @Query('duration') duration: string,
  ) : Promise<Slot[]> {
    const dur = parseFloat(duration) || 2;
    return this.svc.getAvailableSlots(cookId, date, dur);
  }
}
