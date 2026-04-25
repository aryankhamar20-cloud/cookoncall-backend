import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// "HH:mm" 24-hour
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class TimeWindowDto {
  @IsString()
  @Matches(TIME_REGEX, { message: 'start must be HH:mm (24h)' })
  start: string;

  @IsString()
  @Matches(TIME_REGEX, { message: 'end must be HH:mm (24h)' })
  end: string;
}

export class UpsertScheduleDto {
  @IsInt()
  @Min(0)
  @Max(6)
  weekday: number;

  @IsBoolean()
  enabled: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimeWindowDto)
  windows: TimeWindowDto[];
}

export class UpsertOverrideDto {
  /** YYYY-MM-DD */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @IsBoolean()
  closed: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimeWindowDto)
  windows: TimeWindowDto[];

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateAvailabilitySettingsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7 * 24 * 60) // up to 1 week advance
  min_advance_notice_minutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240) // up to 4hr buffer
  booking_buffer_minutes?: number;
}
