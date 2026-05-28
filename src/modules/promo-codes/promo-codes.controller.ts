import {
  Controller, Get, Post, Patch, Body, Param,
} from '@nestjs/common';
import { PromoCodesService } from './promo-codes.service';
import { CreatePromoCodeDto, ValidatePromoCodeDto } from './dto/promo-code.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/user.entity';
import { User } from '../users/user.entity';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

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
  async create(@Body() dto: CreatePromoCodeDto) {
    return this.promoCodesService.create(dto);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — list all promo codes' })
  async findAll() {
    return this.promoCodesService.findAll();
  }

  @Patch(':id/toggle')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin — toggle promo code active status' })
  async toggle(@Param('id') id: string) {
    return this.promoCodesService.toggle(id);
  }
}
