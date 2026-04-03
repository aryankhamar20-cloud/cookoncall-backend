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

  @IsNumber()
  @Min(50)
  @Max(10000)
  @Type(() => Number)
  price_per_session: number;

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

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(10000)
  @Type(() => Number)
  price_per_session?: number;

  @IsOptional()
  @IsBoolean()
  is_veg_only?: boolean;

  @IsOptional()
  @IsBoolean()
  is_available?: boolean;
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
  @IsBoolean()
  @Type(() => Boolean)
  veg_only?: boolean;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  min_price?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  max_price?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  min_rating?: number;

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
