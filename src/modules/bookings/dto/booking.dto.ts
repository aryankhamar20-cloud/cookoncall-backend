import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BookingStatus, BookingType } from '../booking.entity';

export class OrderItemDto {
  @IsUUID()
  menuItemId: string;

  @IsString()
  name: string;

  @IsNumber()
  @Min(1)
  qty: number;

  @IsNumber()
  price: number;
}

// New: for menu checkbox selection during booking
export class SelectedItemDto {
  @IsUUID()
  menuItemId: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  qty?: number; // defaults to 1
}

export class CreateBookingDto {
  @IsUUID()
  cook_id: string;

  @IsEnum(BookingType)
  @IsOptional()
  booking_type?: BookingType;

  @IsDateString()
  scheduled_at: string;

  @IsNumber()
  @Min(1)
  @Max(8)
  @IsOptional()
  @Type(() => Number)
  duration_hours?: number;

  @IsNumber()
  @Min(1)
  @Max(20)
  @IsOptional()
  @Type(() => Number)
  guests?: number;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  dishes?: string;

  @IsOptional()
  @IsString()
  instructions?: string;

  // New: customer selects dishes from chef's menu via checkboxes
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedItemDto)
  selected_items?: SelectedItemDto[];

  // Legacy: for food delivery orders
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  order_items?: OrderItemDto[];
}

export class UpdateBookingStatusDto {
  @IsEnum(BookingStatus)
  status: BookingStatus;

  @IsOptional()
  @IsString()
  cancellation_reason?: string;
}

export class GetBookingsDto {
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;
}
