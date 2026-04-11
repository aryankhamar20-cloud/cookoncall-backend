import { IsEmail, IsNotEmpty, IsString, Length, Matches } from 'class-validator';

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

  @IsString()
  @IsNotEmpty()
  new_password: string;
}

export class GoogleAuthDto {
  @IsString()
  @IsNotEmpty()
  token: string;
}
