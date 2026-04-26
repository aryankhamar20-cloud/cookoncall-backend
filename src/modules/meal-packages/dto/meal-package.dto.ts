import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DishType } from '../../cooks/menu-item.entity';

// ─── DISH DTOs ───────────────────────────────────────────────────────────────

export class CreatePackageCategoryDishDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(DishType)
  type: DishType;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

export class UpdatePackageCategoryDishDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(DishType)
  type?: DishType;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  is_available?: boolean;
}

// ─── CATEGORY DTOs ───────────────────────────────────────────────────────────

export class CreatePackageCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  min_selections?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  max_selections?: number;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  // Inline dishes when creating a category
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePackageCategoryDishDto)
  dishes?: CreatePackageCategoryDishDto[];
}

export class UpdatePackageCategoryDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  min_selections?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  max_selections?: number;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

// ─── ADD-ON DTOs ─────────────────────────────────────────────────────────────

export class CreatePackageAddonDto {
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
  @IsInt()
  @Min(0)
  sort_order?: number;
}

export class UpdatePackageAddonDto {
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
  @IsBoolean()
  is_available?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

// ─── PACKAGE DTOs ────────────────────────────────────────────────────────────

export class CreateMealPackageDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  // Guest-tier prices (all required on creation)
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price_2: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price_3: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price_4: number;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price_5: number;

  // Extra person beyond 5 (defaults to ₹59 per spec)
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  extra_person_charge?: number;

  @IsOptional()
  @IsBoolean()
  is_veg?: boolean;

  @IsOptional()
  @IsString()
  cuisine?: string;

  @IsOptional()
  @IsString()
  ingredient_note?: string;

  // Inline categories + dishes on creation
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePackageCategoryDto)
  categories?: CreatePackageCategoryDto[];

  // Inline add-ons on creation
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePackageAddonDto)
  addons?: CreatePackageAddonDto[];
}

export class UpdateMealPackageDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price_2?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price_3?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price_4?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  price_5?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  extra_person_charge?: number;

  @IsOptional()
  @IsBoolean()
  is_veg?: boolean;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsString()
  cuisine?: string;

  @IsOptional()
  @IsString()
  ingredient_note?: string;
}
