import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DishCategory, DishType } from '../menu-item.entity';

export class CreateCookProfileDto {
  @IsString()
  @IsNotEmpty()
  bio: string;

  @IsString()
  @IsNotEmpty()
  city: string;

  @IsOptional()
  @IsString()
  pincode?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsArray()
  @IsString({ each: true })
  cuisines: string[];

  // Batch B2: price_per_session removed from DTO. Flat ₹49 visit fee model.
  // DB column retained with default 49 for rollback safety.

  @IsOptional()
  @IsBoolean()
  is_veg_only?: boolean;
}

export class UpdateCookProfileDto {
  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  pincode?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cuisines?: string[];

  // Batch B2: price_per_session removed from update DTO.

  @IsOptional()
  @IsBoolean()
  is_veg_only?: boolean;

  @IsOptional()
  @IsBoolean()
  is_available?: boolean;

  // Verification doc URLs (can be updated individually)
  @IsOptional()
  @IsString()
  aadhaar_url?: string;

  @IsOptional()
  @IsString()
  pan_url?: string;

  @IsOptional()
  @IsString()
  address_proof_url?: string;

  @IsOptional()
  @IsString()
  fssai_url?: string;

  @IsOptional()
  @IsString()
  emergency_contact_name?: string;

  @IsOptional()
  @IsString()
  emergency_contact_phone?: string;
}

// ─── SUBMIT VERIFICATION ────────────────────────────────
// Chef uploads all required docs + info and submits for admin review
export class SubmitVerificationDto {
  @IsString()
  @IsNotEmpty()
  aadhaar_url: string;

  @IsString()
  @IsNotEmpty()
  pan_url: string;

  @IsOptional()
  @IsString()
  address_proof_url?: string;

  @IsOptional()
  @IsString()
  fssai_url?: string;

  @IsString()
  @IsNotEmpty()
  emergency_contact_name: string;

  @IsString()
  @IsNotEmpty()
  emergency_contact_phone: string;

  @IsBoolean()
  terms_accepted: boolean;
}

export class CreateMenuItemDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price: number;

  @IsEnum(DishType)
  type: DishType;

  @IsOptional()
  @IsEnum(DishCategory)
  category?: DishCategory;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  image?: string;
}

export class UpdateMenuItemDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price?: number;

  @IsOptional()
  @IsEnum(DishType)
  type?: DishType;

  @IsOptional()
  @IsEnum(DishCategory)
  category?: DishCategory;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsBoolean()
  is_available?: boolean;
}

export class SearchCooksDto {
  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  cuisine?: string;

  @IsOptional()
  @IsString()
  search?: string; // Search by chef name

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  veg_only?: boolean;

  // Batch B2: min_price / max_price removed from search DTO. Flat ₹49 visit fee model.

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  min_rating?: number;

  @IsOptional()
  @IsString()
  sort_by?: string; // 'rating' | 'bookings'

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
