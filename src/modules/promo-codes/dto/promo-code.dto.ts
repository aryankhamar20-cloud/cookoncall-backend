import {
  IsString, IsEnum, IsNumber, IsBoolean, IsOptional,
  IsDateString, Min, Max, Length,
} from 'class-validator';
import { PromoType } from '../promo-code.entity';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePromoCodeDto {
  @ApiProperty({ example: 'WELCOME20' })
  @IsString()
  @Length(2, 20)
  code: string;

  @ApiProperty({ enum: PromoType })
  @IsEnum(PromoType)
  type: PromoType;

  @ApiProperty({ example: 20 })
  @IsNumber()
  @Min(0)
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
  @IsOptional()
  description?: string;
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
