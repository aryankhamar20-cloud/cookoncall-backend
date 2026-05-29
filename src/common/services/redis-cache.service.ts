import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import { createHash } from 'crypto';

/**
 * Generic key/value Redis cache used by the response cache interceptor
 * and any service that wants to memoise a hot read.
 *
 * Design notes
 * ────────────
 * - Single shared client across the process (lazy init in constructor).
 * - All operations are fail-open: if Redis is down or REDIS_URL is unset
 *   we behave like a no-op cache so requests are still served from the
 *   origin. We never want a Redis outage to take down the API.
 * - Values are stored as JSON strings (NOT Buffer) so debugging via
 *   redis-cli is trivial and TTL is set on every write.
 * - Prefixed namespacing (`get`, `set`, `delByPrefix`) lets each module
 *   invalidate its own slice without touching unrelated keys.
 */
@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private client: RedisClientType | null = null;
  private connected = false;

  constructor(private readonly config: ConfigService) {
    this.init();
  }

  private async init(): Promise<void> {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn('REDIS_URL not set — response cache disabled (fail-open)');
      return;
    }
    try {
      this.client = createClient({ url }) as RedisClientType;
      this.client.on('error', (err) => {
        // We get many of these during transient network blips, so log at warn.
        this.logger.warn(`Redis cache error: ${err.message}`);
        this.connected = false;
      });
      this.client.on('connect', () => {
        this.connected = true;
        this.logger.log('Redis cache connected');
      });
      await this.client.connect();
    } catch (err: any) {
      this.logger.error(`Failed to init Redis cache: ${err?.message || err}`);
    }
  }

  /** True when the underlying client is up. Callers should NOT rely on it
   *  for correctness — the get/set helpers already fail-open — but a few
   *  optional features (ETag) want to know whether to bother computing. */
  isReady(): boolean {
    return !!this.client && this.connected;
  }

  /**
   * Read a JSON value. Returns `null` on miss, error or when Redis is down.
   */
  async get<T = unknown>(key: string): Promise<T | null> {
    if (!this.isReady()) return null;
    try {
      const raw = await this.client!.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err: any) {
      this.logger.warn(`cache.get(${key}) failed: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * Write a JSON value with TTL in seconds. Silently ignored when Redis
   * is unavailable.
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.isReady()) return;
    try {
      await this.client!.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (err: any) {
      this.logger.warn(`cache.set(${key}) failed: ${err?.message || err}`);
    }
  }

  /**
   * SET-NX (set-if-not-exists) with TTL — the canonical idempotency
   * primitive. Returns:
   *
   *   true  — the key did not exist; we just claimed it. Caller should
   *           proceed with the side-effect.
   *   false — the key already existed (some earlier delivery claimed
   *           it within the TTL window). Caller MUST treat the request
   *           as a duplicate and drop it.
   *
   * Fail-open: when Redis is unreachable (or the SET errors) we return
   * true. The reasoning is the same as every other helper in this file
   * — better to occasionally process a duplicate than to silently drop
   * a legitimate first-time event because Redis blipped. Idempotency
   * is a best-effort optimisation here, not a correctness requirement
   * (the underlying state machines — booking accept/reject etc — are
   * themselves idempotent and refuse duplicate transitions with a
   * clear error).
   *
   * Used by the WhatsApp inbound webhook (Phase 3) to dedupe Meta's
   * retried `messages.<wamid>` deliveries inside a 5-minute window.
   */
  async setIfNotExists(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (!this.isReady()) return true;
    try {
      // redis v4 returns 'OK' when the SET succeeded, null when the
      // NX condition prevented the write.
      const result = await this.client!.set(key, JSON.stringify(value), {
        NX: true,
        EX: ttlSeconds,
      });
      return result === 'OK';
    } catch (err: any) {
      this.logger.warn(`cache.setIfNotExists(${key}) failed: ${err?.message || err}`);
      return true;
    }
  }

  /** Delete a single key. */
  async del(key: string): Promise<void> {
    if (!this.isReady()) return;
    try {
      await this.client!.del(key);
    } catch (err: any) {
      this.logger.warn(`cache.del(${key}) failed: ${err?.message || err}`);
    }
  }

  /**
   * Invalidate every key starting with `prefix`. Uses SCAN (non-blocking)
   * so it's safe to call from request handlers even on large keyspaces.
   *
   * Typical use: when a cook updates their menu we call
   *   delByPrefix('cache:cooks:')
   *   delByPrefix(`cache:meal-packages:cook:${cookId}`)
   * to ensure the next read pulls fresh data.
   */
  async delByPrefix(prefix: string): Promise<number> {
    if (!this.isReady()) return 0;
    let removed = 0;
    try {
      // Iterate in batches of 200 to keep CPU low.
      for await (const key of this.client!.scanIterator({
        MATCH: `${prefix}*`,
        COUNT: 200,
      })) {
        await this.client!.del(key);
        removed++;
      }
    } catch (err: any) {
      this.logger.warn(`cache.delByPrefix(${prefix}) failed: ${err?.message || err}`);
    }
    return removed;
  }

  /**
   * Build a stable cache key from any inputs (URL + query params + role).
   * SHA-1 keeps it short and indexable; we don't need cryptographic
   * strength here, just collision resistance.
   */
  static buildKey(...parts: (string | number | undefined | null)[]): string {
    const joined = parts.map((p) => (p == null ? '' : String(p))).join('|');
    return createHash('sha1').update(joined).digest('hex');
  }

  async onModuleDestroy() {
    if (this.client && this.connected) {
      try {
        await this.client.quit();
      } catch {
        // ignore
      }
    }
  }
}
