import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
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

// For menu checkbox selection during booking (Build Your Own)
export class SelectedItemDto {
  @IsUUID()
  menuItemId: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  qty?: number;
}

// ─── PACKAGE BOOKING (P1.5c) ─────────────────────────────────────
// Customer picks which dishes to include from each category.
// Each category has min/max_selections enforced at service layer.
export class SelectedCategoryDto {
  @IsUUID()
  categoryId: string;

  @IsArray()
  @IsUUID('all', { each: true })
  dishIds: string[];
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

  // ─── Build Your Own: customer selects from chef's menu ─
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedItemDto)
  selected_items?: SelectedItemDto[];

  // ─── Legacy: for food delivery orders ──────────────────
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  order_items?: OrderItemDto[];

  // ─── Package Booking (P1.5c) ───────────────────────────
  // If packageId is provided, selected_items is ignored and package
  // pricing logic takes over. cook_id must still match.
  @IsOptional()
  @IsUUID()
  packageId?: string;

  // Explicit guest count for package tier pricing (2/3/4/5/custom).
  // Falls back to `guests` field if omitted.
  @IsOptional()
  @IsNumber()
  @Min(2)
  @Max(50)
  @Type(() => Number)
  guestCount?: number;

  // Which dishes the customer selected per category.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedCategoryDto)
  selectedCategories?: SelectedCategoryDto[];

  // Add-on IDs from the package's addon list.
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  selectedAddonIds?: string[];
}

export class UpdateBookingStatusDto {
  @IsEnum(BookingStatus)
  status: BookingStatus;

  @IsOptional()
  @IsString()
  cancellation_reason?: string;
}

// ─── Chef rejects a booking ────────────────────────────
export class RejectBookingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

// ─── Rebook with a different chef after rejection/expiry ─
export class RebookDto {
  @IsUUID()
  new_cook_id: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedItemDto)
  selected_items: SelectedItemDto[];

  @IsOptional()
  @IsString()
  instructions?: string;
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
