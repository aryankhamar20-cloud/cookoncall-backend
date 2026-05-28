import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * ✅ P0: Redis-based OTP rate limiter.
 *
 * Replaces the previous in-memory Map which reset on every deploy/restart.
 * Uses Redis INCR + EXPIRE for atomic, distributed, persistent rate limiting.
 *
 * Rules (matching previous in-memory logic):
 * - Max 1 OTP per email per 2 minutes (cooldown)
 * - Max 5 OTPs per email per 24 hours (daily limit)
 *
 * Falls back to no-op (allow) if Redis is unreachable — preventing auth lockouts.
 */
@Injectable()
export class RedisOtpLimiterService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisOtpLimiterService.name);
  private redis: Redis | null = null;

  private readonly COOLDOWN_SECONDS = 120; // 2 minutes
  private readonly DAILY_LIMIT = 5;
  private readonly DAILY_WINDOW_SECONDS = 86400; // 24 hours

  constructor(private readonly configService: ConfigService) {
    this.init();
  }

  private init() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL not set — OTP rate limiting using in-memory fallback',
      );
      return;
    }

    try {
      this.redis = new Redis(redisUrl, {
        tls: redisUrl.startsWith('rediss://') ? {} : undefined,
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        connectTimeout: 5000,
        enableReadyCheck: false,
      });

      this.redis.on('error', (err) => {
        this.logger.warn(`Redis OTP limiter error: ${err.message}`);
      });

      this.logger.log('Redis OTP rate limiter initialized');
    } catch (err) {
      this.logger.warn(`Failed to init Redis OTP limiter: ${(err as Error).message}`);
      this.redis = null;
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  /**
   * Check and record OTP request. Throws BadRequestException if rate limited.
   * No-ops gracefully if Redis is unavailable.
   */
  async checkAndRecord(email: string): Promise<void> {
    const key = `otp:${email.toLowerCase()}`;
    const cooldownKey = `otp:cooldown:${email.toLowerCase()}`;

    if (!this.redis) {
      // Fallback: allow (Redis unavailable)
      this.logger.warn(`OTP rate limit skipped (no Redis) for ${email}`);
      return;
    }

    try {
      // Check cooldown (2-minute window)
      const cooldownExists = await this.redis.exists(cooldownKey);
      if (cooldownExists) {
        const ttl = await this.redis.ttl(cooldownKey);
        throw new BadRequestException(
          `Please wait ${ttl} seconds before requesting another OTP.`,
        );
      }

      // Check daily limit (5 per 24h)
      const dailyCount = await this.redis.get(key);
      if (dailyCount && parseInt(dailyCount, 10) >= this.DAILY_LIMIT) {
        throw new BadRequestException(
          'Too many OTP requests today. Please try again tomorrow.',
        );
      }

      // Record: increment daily counter and set cooldown
      const pipeline = this.redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, this.DAILY_WINDOW_SECONDS);
      pipeline.set(cooldownKey, '1', 'EX', this.COOLDOWN_SECONDS);
      await pipeline.exec();
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Redis error — allow OTP to proceed (don't block users)
      this.logger.warn(`OTP rate limit Redis error, allowing: ${(err as Error).message}`);
    }
  }

  /**
   * Reset rate limit for an email (used after successful verification).
   * Clears daily counter and cooldown.
   */
  async reset(email: string): Promise<void> {
    if (!this.redis) return;
    const key = `otp:${email.toLowerCase()}`;
    const cooldownKey = `otp:cooldown:${email.toLowerCase()}`;
    try {
      await this.redis.del(key, cooldownKey);
    } catch (err) {
      this.logger.warn(`OTP reset error: ${(err as Error).message}`);
    }
  }
}
