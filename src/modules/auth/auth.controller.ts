import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  ForgotPasswordDto,
  GoogleAuthDto,
  RefreshTokenDto,
  ResetPasswordDto,
  SendOtpDto,
  VerifyOtpDto,
  SendEmailOtpDto,
  VerifyEmailOtpDto,
} from './dto/otp.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── REGISTER ─────────────────────────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 10 } })
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  // ─── LOGIN ────────────────────────────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 10 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // ─── GOOGLE OAUTH ─────────────────────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 10 } })
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async googleAuth(@Body() dto: GoogleAuthDto) {
    return this.authService.googleAuth(dto);
  }

  // ─── SEND OTP (phone) ─────────────────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 5 } })
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto);
  }

  // ─── VERIFY OTP (phone) ───────────────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 10 } })
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  // ─── SEND EMAIL OTP ───────────────────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 5 } })
  @Post('send-email-otp')
  @HttpCode(HttpStatus.OK)
  async sendEmailOtp(@Body() dto: SendEmailOtpDto) {
    return this.authService.sendEmailOtp(dto);
  }

  // ─── VERIFY EMAIL OTP ─────────────────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 10 } })
  @Post('verify-email-otp')
  @HttpCode(HttpStatus.OK)
  async verifyEmailOtp(@Body() dto: VerifyEmailOtpDto) {
    return this.authService.verifyEmailOtp(dto);
  }

  // ─── FORGOT PASSWORD ──────────────────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 5 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  // ─── VERIFY FORGOT PASSWORD OTP ───────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 10 } })
  @Post('verify-forgot-otp')
  @HttpCode(HttpStatus.OK)
  async verifyForgotOtp(@Body() dto: { email: string; otp: string }) {
    return this.authService.verifyForgotOtp(dto);
  }

  // ─── RESET PASSWORD ───────────────────────────────────────────────────────
  @Public()
  @Throttle({ strict: { ttl: 60000, limit: 10 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  // ─── REFRESH TOKEN ────────────────────────────────────────────────────────
  @Public()
  @SkipThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshTokens(dto.refresh_token);
  }

  // ─── LOGOUT ───────────────────────────────────────────────────────────────
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentUser() user: User) {
    return this.authService.logout(user.id);
  }

  // ─── GET CURRENT USER ─────────────────────────────────────────────────────
  @SkipThrottle()
  @Get('me')
  async getMe(@CurrentUser() user: User) {
    return this.authService.getMe(user.id);
  }
}
