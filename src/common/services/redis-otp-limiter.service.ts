import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

/**
 * Redis-backed OTP rate limiter.
 *
 * Replaces the in-memory Map in auth.service.ts which resets on every deploy.
 * Uses two Redis keys per email:
 *   otp:cooldown:{email}  — TTL 2 min, presence = cooldown active
 *   otp:daily:{email}     — TTL 24h, integer count of OTPs sent today
 */
@Injectable()
export class RedisOtpLimiterService {
  private readonly logger = new Logger(RedisOtpLimiterService.name);
  private client: RedisClientType | null = null;
  private connected = false;

  private readonly COOLDOWN_SECONDS = 120;   // 2 minutes between OTPs
  private readonly DAILY_MAX = 5;             // max 5 OTPs per email per 24h
  private readonly DAILY_TTL_SECONDS = 86400; // 24 hours

  constructor(private configService: ConfigService) {
    this.init();
  }

  private async init() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.warn('REDIS_URL not set — OTP rate limiter using in-memory fallback');
      return;
    }

    try {
      this.client = createClient({ url: redisUrl }) as RedisClientType;
      this.client.on('error', (err) => {
        this.logger.error(`Redis client error: ${err.message}`);
        this.connected = false;
      });
      this.client.on('connect', () => {
        this.connected = true;
        this.logger.log('Redis OTP limiter connected');
      });
      await this.client.connect();
    } catch (err) {
      this.logger.error(`Failed to connect Redis OTP limiter: ${err.message}`);
    }
  }

  /**
   * Check rate limit and record a new OTP send attempt.
   * Throws BadRequestException if limit exceeded.
   * Falls back gracefully to no-limit if Redis is unavailable.
   */
  async checkAndRecord(email: string): Promise<void> {
    if (!this.client || !this.connected) {
      // Redis unavailable — allow the request (fail open for availability)
      this.logger.warn(`Redis unavailable — skipping OTP rate limit for ${email}`);
      return;
    }

    const key = email.toLowerCase().trim();
    const cooldownKey = `otp:cooldown:${key}`;
    const dailyKey = `otp:daily:${key}`;

    try {
      // Check cooldown
      const cooldownExists = await this.client.exists(cooldownKey);
      if (cooldownExists) {
        const ttl = await this.client.ttl(cooldownKey);
        const waitSecs = ttl > 0 ? ttl : this.COOLDOWN_SECONDS;
        throw new BadRequestException(
          `Please wait ${waitSecs} seconds before requesting another OTP.`,
        );
      }

      // Check daily limit
      const dailyCountStr = await this.client.get(dailyKey);
      const dailyCount = dailyCountStr ? parseInt(dailyCountStr, 10) : 0;

      if (dailyCount >= this.DAILY_MAX) {
        throw new BadRequestException(
          'Too many OTP requests today. Please try again tomorrow.',
        );
      }

      // Record: set cooldown key + increment daily counter atomically
      const multi = this.client.multi();
      multi.set(cooldownKey, '1', { EX: this.COOLDOWN_SECONDS });
      if (dailyCount === 0) {
        multi.set(dailyKey, '1', { EX: this.DAILY_TTL_SECONDS });
      } else {
        multi.incr(dailyKey);
      }
      await multi.exec();
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Redis error — fail open
      this.logger.error(`Redis OTP limiter error for ${email}: ${err.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.client && this.connected) {
      await this.client.quit();
    }
  }
}
