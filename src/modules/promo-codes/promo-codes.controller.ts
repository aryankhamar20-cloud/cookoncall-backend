import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PromoCodesService } from './promo-codes.service';
import {
  CreatePromoCodeDto,
  UpdatePromoCodeDto,
  ValidatePromoCodeDto,
} from './dto/promo-code.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';
import { User } from '../users/user.entity';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

/**
 * Pull a request's IP + user-agent for the audit row. Mirrors the
 * helper in admin.controller.ts so audit_log entries from /admin and
 * /promo-codes routes look consistent.
 */
function auditMeta(req: Request): { ip: string | null; userAgent: string | null } {
  const fwd = (req.headers['x-forwarded-for'] as string) || '';
  const ip = fwd.split(',')[0].trim() || req.ip || null;
  const userAgent = (req.headers['user-agent'] as string) || null;
  return { ip, userAgent };
}

@ApiTags('Promo Codes')
@ApiBearerAuth('access-token')
@Controller('promo-codes')
export class PromoCodesController {
  constructor(private readonly promoCodesService: PromoCodesService) {}

  // ─── CUSTOMER: Validate a promo code before booking ──
  @Post('validate')
  @ApiOperation({ summary: 'Validate a promo code and get discount amount' })
  async validate(
    @CurrentUser() user: User,
    @Body() dto: ValidatePromoCodeDto,
  ) {
    return this.promoCodesService.validate(user.id, dto);
  }

  // ─── ADMIN ONLY ──────────────────────────────────────

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — create a new promo code' })
  async create(
    @Body() dto: CreatePromoCodeDto,
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.promoCodesService.create(dto, admin, auditMeta(req));
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — list all promo codes' })
  async findAll(@Query('status') status?: string) {
    return this.promoCodesService.findAll(status);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — get a single promo code by id' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.promoCodesService.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — update a promo code (cannot change code)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromoCodeDto,
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.promoCodesService.update(id, dto, admin, auditMeta(req));
  }

  @Patch(':id/toggle')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — toggle promo code active status' })
  async toggle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.promoCodesService.toggle(id, admin, auditMeta(req));
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary:
      'Admin — delete a promo code (only if never used; otherwise deactivate)',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: User,
    @Req() req: Request,
  ) {
    return this.promoCodesService.remove(id, admin, auditMeta(req));
  }

  @Get(':id/usages')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — list redemption history for a promo code' })
  async listUsages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.promoCodesService.listUsages(
      id,
      page ? Number(page) : 1,
      Math.min(limit ? Number(limit) : 50, 200),
    );
  }
}
