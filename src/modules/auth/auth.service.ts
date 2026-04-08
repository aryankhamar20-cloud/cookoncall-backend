import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from '../users/user.entity';
import { Cook } from '../cooks/cook.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  SendOtpDto,
  VerifyOtpDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  GoogleAuthDto,
} from './dto/otp.dto';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Cook)
    private cooksRepository: Repository<Cook>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  // ─── REGISTER ──────────────────────────────────────────
  async register(dto: RegisterDto) {
    const exists = await this.usersRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (exists) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    const user = this.usersRepository.create({
      name: dto.name,
      email: dto.email.toLowerCase(),
      phone: dto.phone || null,
      password: hashedPassword,
      role: dto.role || UserRole.USER,
    });

    await this.usersRepository.save(user);

    // If registering as a cook, create their cook profile
    if (user.role === UserRole.COOK) {
      const cookProfile = this.cooksRepository.create({
        user_id: user.id,
        cuisines: dto.specialties
          ? dto.specialties.split(',').map((s) => s.trim())
          : [],
        price_per_session: dto.rate || 200,
        bio: dto.experience || null,
      });
      await this.cooksRepository.save(cookProfile);
    }

    const tokens = await this.generateTokens(user);
    await this.updateRefreshToken(user.id, tokens.refresh_token);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  // ─── LOGIN ─────────────────────────────────────────────
  async login(dto: LoginDto) {
    const user = await this.usersRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Account is deactivated');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.generateTokens(user);
    await this.updateRefreshToken(user.id, tokens.refresh_token);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  // ─── GOOGLE OAUTH ──────────────────────────────────────
  async googleAuth(dto: GoogleAuthDto) {
    // Verify the Google ID token
    const googlePayload = await this.verifyGoogleToken(dto.token);

    if (!googlePayload || !googlePayload.email) {
      throw new UnauthorizedException('Invalid Google token');
    }

    let user = await this.usersRepository.findOne({
      where: { email: googlePayload.email.toLowerCase() },
    });

    if (!user) {
      // Create new user from Google
      user = this.usersRepository.create({
        name: googlePayload.name || 'User',
        email: googlePayload.email.toLowerCase(),
        google_id: googlePayload.sub,
        avatar: googlePayload.picture || null,
        role: UserRole.USER,
      });
      await this.usersRepository.save(user);
    } else if (!user.google_id) {
      // Link Google account to existing user
      user.google_id = googlePayload.sub;
      if (!user.avatar && googlePayload.picture) {
        user.avatar = googlePayload.picture;
      }
      await this.usersRepository.save(user);
    }

    const tokens = await this.generateTokens(user);
    await this.updateRefreshToken(user.id, tokens.refresh_token);

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  // ─── SEND OTP (via MSG91) ─────────────────────────────
  async sendOtp(dto: SendOtpDto) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Find user by phone
    const user = await this.usersRepository.findOne({
      where: { phone: dto.phone },
    });

    if (!user) {
      throw new BadRequestException('No account found with this phone number');
    }

    user.otp = otp;
    user.otp_expires_at = otpExpiresAt;
    await this.usersRepository.save(user);

    // Send OTP via MSG91
    await this.sendOtpViaMSG91(dto.phone, otp);

    return { message: 'OTP sent successfully' };
  }

  // ─── VERIFY OTP ────────────────────────────────────────
  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.usersRepository.findOne({
      where: { phone: dto.phone },
    });

    if (!user) {
      throw new BadRequestException('No account found with this phone number');
    }

    if (!user.otp || !user.otp_expires_at) {
      throw new BadRequestException('No OTP requested. Please request a new OTP.');
    }

    if (new Date() > user.otp_expires_at) {
      user.otp = null;
      user.otp_expires_at = null;
      await this.usersRepository.save(user);
      throw new BadRequestException('OTP has expired. Please request a new one.');
    }

    if (user.otp !== dto.otp) {
      throw new BadRequestException('Invalid OTP');
    }

    // OTP verified — mark phone as verified, clear OTP
    user.phone_verified = true;
    user.otp = null;
    user.otp_expires_at = null;
    await this.usersRepository.save(user);

    return { message: 'Phone verified successfully' };
  }

  // ─── FORGOT PASSWORD ──────────────────────────────────
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.usersRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      // Don't reveal if email exists — always return success
      return { message: 'If the email exists, a reset OTP has been sent' };
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otp_expires_at = new Date(Date.now() + 5 * 60 * 1000);
    await this.usersRepository.save(user);

    // Send OTP via email (Nodemailer)
    await this.sendPasswordResetEmail(user.email, otp);

    return { message: 'If the email exists, a reset OTP has been sent' };
  }

  // ─── RESET PASSWORD ───────────────────────────────────
  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.usersRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user || !user.otp || !user.otp_expires_at) {
      throw new BadRequestException('Invalid reset request');
    }

    if (new Date() > user.otp_expires_at) {
      throw new BadRequestException('OTP expired');
    }

    if (user.otp !== dto.otp) {
      throw new BadRequestException('Invalid OTP');
    }

    user.password = await bcrypt.hash(dto.new_password, 12);
    user.otp = null;
    user.otp_expires_at = null;
    await this.usersRepository.save(user);

    return { message: 'Password reset successful' };
  }

  // ─── REFRESH TOKEN ─────────────────────────────────────
  async refreshTokens(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      const user = await this.usersRepository.findOne({
        where: { id: payload.sub },
      });

      if (!user || !user.refresh_token || !user.is_active) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const isMatch = await bcrypt.compare(refreshToken, user.refresh_token);
      if (!isMatch) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const tokens = await this.generateTokens(user);
      await this.updateRefreshToken(user.id, tokens.refresh_token);

      return tokens;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  // ─── LOGOUT ────────────────────────────────────────────
  async logout(userId: string) {
    await this.usersRepository.update(userId, { refresh_token: null });
    return { message: 'Logged out successfully' };
  }

  // ─── GET CURRENT USER (ME) ─────────────────────────────
  async getMe(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.sanitizeUser(user);
  }

  // ═══════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════

  private async generateTokens(user: User) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const [access_token, refresh_token] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);

    return { access_token, refresh_token };
  }

  private async updateRefreshToken(userId: string, refreshToken: string) {
    const hashed = await bcrypt.hash(refreshToken, 12);
    await this.usersRepository.update(userId, { refresh_token: hashed });
  }

  private sanitizeUser(user: User) {
    const { password, refresh_token, otp, otp_expires_at, ...sanitized } = user;
    return sanitized;
  }

  private async verifyGoogleToken(
    token: string,
  ): Promise<{ email: string; name: string; sub: string; picture?: string } | null> {
    try {
      // Use Google's tokeninfo endpoint to verify the ID token
      const response = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${token}`,
      );

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');

      // Verify the token was issued for our app
      if (payload.aud !== clientId) {
        return null;
      }

      return {
        email: payload.email,
        name: payload.name,
        sub: payload.sub,
        picture: payload.picture,
      };
    } catch (error) {
      this.logger.error('Google token verification failed', error);
      return null;
    }
  }

  private async sendOtpViaMSG91(phone: string, otp: string) {
    const authKey = this.configService.get<string>('MSG91_AUTH_KEY');
    const templateId = this.configService.get<string>('MSG91_OTP_TEMPLATE_ID');

    if (!authKey || !templateId) {
      this.logger.warn('MSG91 not configured — OTP not sent. OTP: ' + otp);
      return;
    }

    try {
      const response = await fetch('https://control.msg91.com/api/v5/otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authkey: authKey,
        },
        body: JSON.stringify({
          template_id: templateId,
          mobile: `91${phone}`,
          otp,
        }),
      });

      const data = await response.json();
      this.logger.log(`MSG91 OTP response: ${JSON.stringify(data)}`);
    } catch (error) {
      this.logger.error('MSG91 OTP send failed', error);
      // Don't throw — we already saved the OTP, user can retry
    }
  }

  private async sendPasswordResetEmail(email: string, otp: string) {
    // This will be handled by the NotificationsModule queue
    // For now, log it
    this.logger.log(`Password reset OTP for ${email}: ${otp}`);
    // TODO: Inject NotificationsService and use email queue
  }
}
