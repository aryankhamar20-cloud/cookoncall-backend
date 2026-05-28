import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class SendOtpDto {
  @Matches(/^[6-9]\d{9}$/, { message: 'Enter a valid 10-digit Indian phone number' })
  phone: string;
}

export class VerifyOtpDto {
  @Matches(/^[6-9]\d{9}$/, { message: 'Enter a valid 10-digit Indian phone number' })
  phone: string;

  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  otp: string;
}

// ─── Email OTP (for email verification after signup) ────
export class SendEmailOtpDto {
  @IsEmail()
  email: string;
}

export class VerifyEmailOtpDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  otp: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refresh_token: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(6, 6)
  otp: string;

  // Round 2 hardening: same complexity rules as registration so reset
  // doesn't ship weaker passwords than signup.
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(72, { message: 'Password must be 72 characters or less' })
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'Password must contain at least one letter and one number',
  })
  new_password: string;
}

export class GoogleAuthDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  /**
   * Round 4 — only honored when this is a brand-new account (no
   * matching `users.email` row). Existing accounts keep their role
   * regardless of what the client sends, so a Chef can't be silently
   * downgraded to Customer (or vice-versa) by signing in through the
   * wrong "Sign up as ..." button.
   *
   * Defaults to 'user' on the server when omitted.
   */
  @IsString()
  @IsOptional()
  @IsIn(['user', 'cook'])
  role?: 'user' | 'cook';
}
