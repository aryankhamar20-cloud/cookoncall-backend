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
import * as nodemailer from 'nodemailer';
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
  SendEmailOtpDto,
  VerifyEmailOtpDto,
} from './dto/otp.dto';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private transporter: nodemailer.Transporter;

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Cook)
    private cooksRepository: Repository<Cook>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    // Direct SMTP transporter — no BullMQ/Redis dependency
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST', 'smtp.gmail.com'),
      port: this.configService.get<number>('SMTP_PORT', 587),
      secure: false,
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  // ─── REGISTER ──────────────────────────────────────────
  async register(dto: RegisterDto) {
    const exists = await this.usersRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (exists) {
      throw new ConflictException('Email already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    const requestedRole = dto.role || UserRole.USER;
    const safeRole =
      requestedRole === UserRole.COOK ? UserRole.COOK : UserRole.USER;

    const user = this.usersRepository.create({
      name: dto.name,
      email: dto.email.toLowerCase(),
      phone: dto.phone || null,
      password: hashedPassword,
      role: safeRole,
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

    // Send email verification OTP automatically after registration
    try {
      await this.sendEmailVerificationOtp(user);
    } catch (err) {
      this.logger.warn(`Failed to send verification email to ${user.email}: ${err.message}`);
    }

    return {
      user: this.sanitizeUser(user),
      ...tokens,
      email_verification_sent: true,
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
    const googlePayload = await this.verifyGoogleToken(dto.token);

    if (!googlePayload || !googlePayload.email) {
      throw new UnauthorizedException('Invalid Google token');
    }

    let user = await this.usersRepository.findOne({
      where: { email: googlePayload.email.toLowerCase() },
    });

    if (!user) {
      user = this.usersRepository.create({
        name: googlePayload.name || 'User',
        email: googlePayload.email.toLowerCase(),
        google_id: googlePayload.sub,
        avatar: googlePayload.picture || null,
        role: UserRole.USER,
        email_verified: true, // Google accounts are pre-verified
      });
      await this.usersRepository.save(user);
    } else if (!user.google_id) {
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

  // ─── SEND EMAIL OTP (for email verification) ──────────
  async sendEmailOtp(dto: SendEmailOtpDto) {
    const user = await this.usersRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      throw new BadRequestException('No account found with this email');
    }

    if (user.email_verified) {
      return { message: 'Email already verified' };
    }

    await this.sendEmailVerificationOtp(user);

    return { message: 'Verification OTP sent to your email' };
  }

  // ─── VERIFY EMAIL OTP ─────────────────────────────────
  async verifyEmailOtp(dto: VerifyEmailOtpDto) {
    const user = await this.usersRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      throw new BadRequestException('No account found with this email');
    }

    if (user.email_verified) {
      return { message: 'Email already verified' };
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

    // OTP verified — mark email as verified
    user.email_verified = true;
    user.otp = null;
    user.otp_expires_at = null;
    await this.usersRepository.save(user);

    return { message: 'Email verified successfully' };
  }

  // ─── SEND OTP (via MSG91 — phone) ─────────────────────
  async sendOtp(dto: SendOtpDto) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const user = await this.usersRepository.findOne({
      where: { phone: dto.phone },
    });

    if (!user) {
      throw new BadRequestException('No account found with this phone number');
    }

    user.otp = otp;
    user.otp_expires_at = otpExpiresAt;
    await this.usersRepository.save(user);

    await this.sendOtpViaMSG91(dto.phone, otp);

    return { message: 'OTP sent successfully' };
  }

  // ─── VERIFY OTP (phone) ───────────────────────────────
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
      return { message: 'If the email exists, a reset OTP has been sent' };
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otp_expires_at = new Date(Date.now() + 5 * 60 * 1000);
    await this.usersRepository.save(user);

    // Send password reset OTP via email
    await this.sendOtpEmail(user.email, otp, 'password_reset');

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

  /** Send email verification OTP to user */
  private async sendEmailVerificationOtp(user: User) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.otp = otp;
    user.otp_expires_at = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await this.usersRepository.save(user);

    await this.sendOtpEmail(user.email, otp, 'email_verification');
  }

  /** Send OTP email via direct SMTP (no Redis/BullMQ needed) */
  private async sendOtpEmail(
    email: string,
    otp: string,
    type: 'email_verification' | 'password_reset',
  ) {
    const smtpUser = this.configService.get<string>('SMTP_USER');
    const smtpPass = this.configService.get<string>('SMTP_PASS');

    if (!smtpUser || !smtpPass) {
      this.logger.warn(`SMTP not configured — OTP for ${email}: ${otp}`);
      return;
    }

    const isVerification = type === 'email_verification';
    const subject = isVerification
      ? 'Verify your CookOnCall account'
      : 'Reset your CookOnCall password';

    const heading = isVerification
      ? 'Verify Your Email'
      : 'Reset Your Password';

    const message = isVerification
      ? 'Thank you for joining CookOnCall! Use the code below to verify your email address.'
      : 'We received a request to reset your password. Use the code below to proceed.';

    const html = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #FFF8F0; border-radius: 16px; padding: 40px 32px; border: 1px solid #FFE4B5;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-weight: 900; font-size: 24px; color: #2D1810;">COOK</span><span style="font-weight: 900; font-size: 24px; color: #D4721A;">ONCALL</span>
        </div>
        <h2 style="text-align: center; color: #2D1810; font-size: 20px; margin-bottom: 8px;">${heading}</h2>
        <p style="text-align: center; color: #8B7355; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
          ${message}
        </p>
        <div style="background: white; border-radius: 12px; padding: 20px; text-align: center; border: 2px dashed #FFB347; margin-bottom: 24px;">
          <div style="font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #D4721A;">${otp}</div>
          <div style="font-size: 12px; color: #8B7355; margin-top: 8px;">Valid for 10 minutes</div>
        </div>
        <p style="text-align: center; color: #B0A090; font-size: 12px;">
          If you didn't request this, please ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #FFE4B5; margin: 24px 0;" />
        <p style="text-align: center; color: #B0A090; font-size: 11px;">
          © ${new Date().getFullYear()} CookOnCall · Ahmedabad, India
        </p>
      </div>
    `;

    try {
      await this.transporter.sendMail({
        from: `"CookOnCall" <${this.configService.get<string>('SMTP_FROM', smtpUser)}>`,
        to: email,
        subject,
        html,
      });
      this.logger.log(`OTP email sent to ${email} (${type})`);
    } catch (error) {
      this.logger.error(`Failed to send OTP email to ${email}`, error);
      // Don't throw — OTP is saved in DB, user can retry
    }
  }

  private async verifyGoogleToken(
    token: string,
  ): Promise<{ email: string; name: string; sub: string; picture?: string } | null> {
    try {
      const response = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${token}`,
      );

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');

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
    }
  }
}
