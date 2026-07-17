import {
  IsUUID,
  IsString,
  MaxLength,
  MinLength,
  IsEnum,
  IsOptional,
  IsNumber,
  Min,
} from 'class-validator';
import { DisputeStatus } from '../dispute.entity';

export class CreateDisputeDto {
  @IsUUID()
  booking_id: string;

  @IsString()
  @MaxLength(40)
  reason: string;

  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  description: string;
}

export class ResolveDisputeDto {
  @IsEnum(DisputeStatus, {
    message: 'status must be under_review, resolved, or rejected',
  })
  status: DisputeStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolution_note?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  refund_amount?: number;
}
