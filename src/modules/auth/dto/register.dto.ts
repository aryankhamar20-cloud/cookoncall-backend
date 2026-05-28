import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '../../users/user.entity';

/**
 * Hardened registration DTO (Round 2).
 *
 * Strengthened from the previous "min 8 chars, anything goes" baseline:
 *   - Name: trimmed, 2-60 chars, letters + spaces only (rejects emoji /
 *     SQL fragments / weird Unicode that would break receipts and emails)
 *   - Email: standard IsEmail() validation, max 120 chars
 *   - Password: min 8 chars + must contain at least one letter and one
 *     digit. Symbol is optional but encouraged on the client (the
 *     PasswordStrength widget gates on Fair = 2/4 score).
 *   - Phone: stays at the existing Indian mobile regex (6-9 + 9 digits)
 *   - specialties / experience / address: capped at 500 chars to keep
 *     the DB row size and the receipt PDF reasonable.
 */
export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(2, 60, { message: 'Name must be between 2 and 60 characters' })
  @Matches(/^[\p{L}][\p{L} .'\-]+$/u, {
    message: 'Name can only contain letters, spaces, hyphens, periods and apostrophes',
  })
  name: string;

  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(120)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;

  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, { message: 'Enter a valid 10-digit Indian phone number' })
  phone?: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(72, { message: 'Password must be 72 characters or less' }) // bcrypt cap
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'Password must contain at least one letter and one number',
  })
  password: string;

  @IsEnum(UserRole, { message: 'Role must be user or cook' })
  @IsOptional()
  role?: UserRole;

  // ─── Address (optional at registration, mandatory at booking) ───
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  // ─── Chef-only fields (optional, used when role = cook) ───
  @IsOptional()
  @IsString()
  @MaxLength(500)
  specialties?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  experience?: string;
}
