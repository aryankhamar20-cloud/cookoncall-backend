import { IsOptional, IsString, Matches } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, { message: 'Enter a valid 10-digit Indian phone number' })
  phone?: string;

  @IsOptional()
  @IsString()
  avatar?: string;
}

export class UserStatsResponseDto {
  total_bookings: number;
  completed_bookings: number;
  total_spent: number;
  favourite_cook: string | null;
}
