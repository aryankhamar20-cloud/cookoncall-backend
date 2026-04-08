import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../users/user.entity';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, { message: 'Enter a valid 10-digit Indian phone number' })
  phone?: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;

  @IsEnum(UserRole, { message: 'Role must be user or cook' })
  @IsOptional()
  role?: UserRole;

  // ─── Chef-only fields (optional, used when role = cook) ───
  @IsOptional()
  @IsString()
  specialties?: string;

  @IsOptional()
  @IsString()
  experience?: string;

  @IsOptional()
  @IsNumber()
  rate?: number;
}
