import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ErrorsService } from './errors.service';
import { CreateErrorLogDto } from './dto/create-error-log.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/user.entity';

@Controller('errors')
export class ErrorsController {
  constructor(private readonly errorsService: ErrorsService) {}

  /**
   * Public endpoint — called by the frontend ErrorBoundary when a React
   * crash is caught. No auth required (user might be logged out when it
   * crashes). JwtAuthGuard short-circuits on @Public() routes and never
   * populates request.user, so we accept user_id directly from the DTO
   * instead (the field is optional and not security-sensitive).
   */
  @Public()
  @Post()
  async logError(@Body() dto: CreateErrorLogDto) {
    return this.errorsService.create(dto);
  }

  /**
   * Admin-only endpoint — view recent error logs in the admin dashboard.
   */
  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async getErrors(@Query('limit') limit?: number) {
    return this.errorsService.getRecent(Number(limit) || 100);
  }
}
