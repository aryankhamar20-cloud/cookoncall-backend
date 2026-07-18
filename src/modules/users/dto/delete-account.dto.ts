import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Self-service account deletion payload.
 *
 * We ask for the current password as a re-authentication step so a
 * hijacked-but-still-logged-in session (or a shoulder-surfer on an
 * unlocked device) can't nuke the account with one tap. For accounts
 * created via Google OAuth there is no password on file, so the field
 * is optional and the service falls back to requiring the explicit
 * `confirm` flag instead.
 *
 * Deletion itself is a SOFT delete: we deactivate the account and
 * scrub personal data (name, email, phone, address, avatar) but keep
 * the row so that historical bookings, payments and payouts — which
 * are financial records we're legally required to retain — stay
 * referentially intact.
 */
export class DeleteAccountDto {
  @ApiProperty({
    required: false,
    description:
      'Current password. Required for password accounts; omit for Google-only accounts.',
  })
  @IsOptional()
  @IsString()
  current_password?: string;

  @ApiProperty({
    required: false,
    description:
      'Explicit confirmation. Required for accounts with no password (Google sign-in).',
  })
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}
