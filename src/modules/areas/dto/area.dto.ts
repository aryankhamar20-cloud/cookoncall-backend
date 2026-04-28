import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestAreaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  city?: string;
}

export class ApproveAreaDto {
  // Slug to use for the new approved area. Must be lowercase + dash-separated.
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  slug: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(['west', 'central', 'north', 'east', 'south'])
  region: string;
}

export class RejectAreaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

// Helper to slugify a free-text area name
export function slugifyAreaName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}
