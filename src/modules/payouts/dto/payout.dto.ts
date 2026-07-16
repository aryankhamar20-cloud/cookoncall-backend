import {
  IsUUID,
  IsNumber,
  IsPositive,
  IsOptional,
  IsString,
  IsEnum,
  IsBoolean,
  IsDateString,
  MaxLength,
} from 'class-validator';
import { PayoutMethod } from '../payout.entity';

export class CreatePayoutDto {
  @IsUUID()
  cook_id: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @IsOptional()
  @IsEnum(PayoutMethod)
  method?: PayoutMethod;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsDateString()
  period_start?: string;

  @IsOptional()
  @IsDateString()
  period_end?: string;

  @IsOptional()
  @IsBoolean()
  mark_paid?: boolean;
}

export class MarkPayoutPaidDto {
  @IsOptional()
  @IsEnum(PayoutMethod)
  method?: PayoutMethod;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
