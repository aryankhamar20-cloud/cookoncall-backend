import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Logged-in password change. Distinct from the forgot-password flow:
 *   - forgot-password is public + email-OTP gated (the user has lost
 *     access to their account, so we verify ownership by email)
 *   - change-password requires a valid JWT AND the current password
 *     (the user is authenticated; we just re-verify they know their
 *     own password before letting them mutate it)
 *
 * Password complexity matches RegisterDto: min 8 chars, must contain
 * at least one letter and one digit. Same rules as the rest of the
 * codebase so a strong password used at signup is still strong here.
 */
export class ChangePasswordDto {
  @ApiProperty({ description: 'The user’s current password' })
  @IsString()
  @IsNotEmpty()
  current_password: string;

  @ApiProperty({ description: 'New password (min 8 chars, letter + digit)' })
  @IsString()
  @MinLength(8, { message: 'New password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'New password must contain at least one letter and one digit',
  })
  new_password: string;
}
