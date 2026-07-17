import {
  IsUUID,
  IsEnum,
  IsArray,
  ArrayNotEmpty,
  IsInt,
  Min,
  Max,
  IsString,
  Matches,
  IsOptional,
  IsNumber,
  IsObject,
  IsDateString,
} from 'class-validator';
import { SubscriptionCadence } from '../subscription.entity';

export class CreateSubscriptionDto {
  @IsUUID()
  cook_id: string;

  @IsEnum(SubscriptionCadence)
  cadence: SubscriptionCadence;

  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days_of_week: number[];

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'time_slot must be HH:mm (24h)' })
  time_slot: string;

  @IsOptional()
  @IsUUID()
  meal_package_id?: string;

  @IsOptional()
  @IsUUID()
  address_id?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  price_per_session?: number;

  // The booking create-payload snapshot (validated by createBooking at
  // generation time). Must at least carry cook_id + address + dishes.
  @IsObject()
  booking_template: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  ends_at?: string;
}
