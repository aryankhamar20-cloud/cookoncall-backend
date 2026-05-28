import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PromoCodesService } from './promo-codes.service';
import { PromoType } from './promo-code.entity';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Public } from '../../common/decorators/public.decorator';
import { User, UserRole } from '../users/user.entity';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

class ValidatePromoDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  order_amount: number;
}

class CreatePromoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  code: string;

  @IsEnum(PromoType)
  type: PromoType;

  @IsNumber()
  @IsPositive()
  value: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  min_order?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  max_discount?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  max_uses?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  max_uses_per_user?: number;

  @IsDateString()
  valid_from: Date;

  @IsDateString()
  valid_until: Date;

  @IsOptional()
  first_booking_only?: boolean;

  @IsOptional()
  @IsString()
  description?: string;
}

@Controller('promo-codes')
export class PromoCodesController {
  constructor(private readonly promoCodesService: PromoCodesService) {}

  // ─── CUSTOMER ENDPOINT ───────────────────────────────
  /** Validate a promo code and get the discount amount */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  async validate(
    @CurrentUser() user: User,
    @Body() dto: ValidatePromoDto,
  ) {
    return this.promoCodesService.validate(dto.code, user.id, dto.order_amount);
  }

  // ─── ADMIN ENDPOINTS ─────────────────────────────────
  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async create(@Body() dto: CreatePromoDto) {
    return this.promoCodesService.create(dto);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async findAll(@Query('active_only') activeOnly?: string) {
    return this.promoCodesService.findAll(activeOnly === 'true');
  }

  @Get(':id/stats')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async getStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.promoCodesService.getUsageStats(id);
  }

  @Patch(':id/toggle')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async toggleActive(@Param('id', ParseUUIDPipe) id: string) {
    return this.promoCodesService.toggleActive(id);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.promoCodesService.remove(id);
  }
}
