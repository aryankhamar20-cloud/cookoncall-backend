import {
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum AnalyticsRange {
  LAST_24H = '24h',
  LAST_7D = '7d',
  LAST_30D = '30d',
  LAST_90D = '90d',
  CUSTOM = 'custom',
}

/**
 * Common query DTO for /admin/analytics/* endpoints.
 *
 * `range` is an enum so URLs stay short for the 99% case (?range=30d).
 * `from` + `to` only kick in when range=custom — the controller
 * validates that one is set.
 */
export class AnalyticsQueryDto {
  @IsOptional()
  @IsEnum(AnalyticsRange)
  range?: AnalyticsRange;

  @IsOptional()
  @IsDateString()
  from?: string; // 'YYYY-MM-DD'

  @IsOptional()
  @IsDateString()
  to?: string;
}

/**
 * Lightweight event tracking payload posted from the web app
 * (POST /events) for client-side analytics. Auth is optional — the
 * controller backfills user_id / role from the JWT if present.
 */
export class TrackEventDto {
  @IsString()
  @Length(1, 64)
  event_type: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  session_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  page_path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  referrer?: string;

  @IsOptional()
  @IsObject()
  @Type(() => Object)
  metadata?: Record<string, unknown>;
}
