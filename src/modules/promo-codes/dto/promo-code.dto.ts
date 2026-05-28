import {
  IsString, IsEnum, IsNumber, IsBoolean, IsOptional,
  IsDateString, Min, Max, Length, Matches,
} from 'class-validator';
import { PromoType } from '../promo-code.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePromoCodeDto {
  @ApiProperty({ example: 'WELCOME20' })
  @IsString()
  @Length(2, 20)
  // Lock down the alphabet so admins can't paste lowercase/symbols
  // that would behave inconsistently with the unique-index lookup
  // (validate() upper-cases the input but a stored lowercase row
  // would never match). Hyphens and underscores are allowed for
  // campaign slugs like SUMMER-2026 / KIRO_LAUNCH.
  @Matches(/^[A-Z0-9_-]+$/i, {
    message: 'Code must contain only letters, digits, hyphen or underscore.',
  })
  code: string;

  @ApiProperty({ enum: PromoType })
  @IsEnum(PromoType)
  type: PromoType;

  @ApiProperty({ example: 20 })
  @IsNumber()
  @Min(0)
  @Max(100000)
  value: number;

  @ApiPropertyOptional({ example: 200 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  max_discount?: number;

  @ApiPropertyOptional({ example: 199 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  min_order_amount?: number;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  single_use?: boolean;

  @ApiPropertyOptional({ example: 500 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  max_uses?: number;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  expires_at?: string;

  @ApiPropertyOptional()
  @IsString()
  @Length(0, 500)
  @IsOptional()
  description?: string;

  /** Initial active state. Defaults true on the entity. */
  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}

/**
 * UpdatePromoCodeDto — patch shape for editing an existing promo.
 * Note: `code` is intentionally NOT updatable. Renaming a code mid-life
 * would break any in-flight customer cart that already validated the
 * old code, and would corrupt the immutable historical usage records.
 * Admins who need a different code must create a new promo and
 * deactivate the old one.
 */
export class UpdatePromoCodeDto {
  @ApiPropertyOptional({ enum: PromoType })
  @IsEnum(PromoType)
  @IsOptional()
  type?: PromoType;

  @ApiPropertyOptional({ example: 20 })
  @IsNumber()
  @Min(0)
  @Max(100000)
  @IsOptional()
  value?: number;

  @ApiPropertyOptional({ example: 200 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  max_discount?: number;

  @ApiPropertyOptional({ example: 199 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  min_order_amount?: number;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  single_use?: boolean;

  @ApiPropertyOptional({ example: 500 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  max_uses?: number;

  @ApiPropertyOptional()
  @IsDateString()
  @IsOptional()
  expires_at?: string;

  @ApiPropertyOptional()
  @IsString()
  @Length(0, 500)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}

export class ValidatePromoCodeDto {
  @ApiProperty({ example: 'WELCOME20' })
  @IsString()
  @Length(2, 20)
  code: string;

  @ApiProperty({ example: 499 })
  @IsNumber()
  @Min(0)
  order_amount: number;
}
