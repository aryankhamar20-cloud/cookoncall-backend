import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import { RedisCacheService } from '../services/redis-cache.service';

// ─── Decorator ───────────────────────────────────────────
// Usage:
//   @CacheResponse({ ttl: 300, prefix: 'cooks', vary: ['query', 'role'] })
//   @Get()
//   async list() { ... }

export interface CacheResponseOptions {
  /** Cache TTL in seconds. Defaults to 300 (5 minutes). */
  ttl?: number;
  /**
   * Logical bucket prefix for invalidation, e.g. 'cooks', 'areas',
   * 'meal-packages:cook:<id>'. Stored on the metadata so write
   * handlers can call `cache.delByPrefix('cache:cooks:')` without
   * having to know the full key shape.
   */
  prefix: string;
  /**
   * Which request fields are part of the cache key. Defaults to
   * ['url'] which already includes the query string. Add 'role' if
   * the response varies by user role; add 'user' if it varies per
   * authenticated user (rare for caching).
   */
  vary?: Array<'url' | 'query' | 'role' | 'user'>;
  /** Browser cache directive. Defaults to 'public, max-age=60'. */
  cacheControl?: string;
}

export const CACHE_RESPONSE_KEY = 'cache:response:options';

export const CacheResponse = (opts: CacheResponseOptions) =>
  SetMetadata(CACHE_RESPONSE_KEY, {
    ttl: 300,
    vary: ['url'],
    cacheControl: 'public, max-age=60',
    ...opts,
  });

/**
 * Read-through Redis cache for HTTP GET handlers, with conditional-GET
 * (ETag / 304 Not Modified) support.
 *
 * Behaviour
 * ─────────
 * 1. Only GET requests are cached.
 * 2. If the cached entry's ETag matches `If-None-Match`, we short-circuit
 *    with HTTP 304 — the client can keep its own copy and we save the
 *    JSON serialisation + Cloudflare bandwidth.
 * 3. If we have a cache HIT we return the cached body and set
 *    `X-Cache: HIT`, otherwise we run the handler, store the body and
 *    set `X-Cache: MISS`.
 * 4. Failures (Redis down, JSON-encode errors) NEVER break the request:
 *    we fall back to running the original handler.
 */
@Injectable()
export class ResponseCacheInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ResponseCacheInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly cache: RedisCacheService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<Request & { user?: { id?: string; role?: string } }>();
    const res = httpCtx.getResponse<Response>();

    // Only cache GETs. POST/PATCH/DELETE flow through unchanged.
    if (req.method !== 'GET') {
      return next.handle();
    }

    const options = this.reflector.get<CacheResponseOptions | undefined>(
      CACHE_RESPONSE_KEY,
      context.getHandler(),
    );
    if (!options) return next.handle();

    const ttl = options.ttl ?? 300;
    const vary = options.vary ?? ['url'];

    // Build the cache key.
    const keyParts: string[] = [`cache:${options.prefix}`];
    if (vary.includes('url')) keyParts.push(req.originalUrl || req.url || '');
    if (vary.includes('query')) keyParts.push(JSON.stringify(req.query || {}));
    if (vary.includes('role')) keyParts.push(req.user?.role || 'anon');
    if (vary.includes('user')) keyParts.push(req.user?.id || 'anon');
    const key = keyParts.join('|');

    // Always advertise our cache policy. Doing this even on miss gives
    // Cloudflare a reason to keep its edge copy.
    if (options.cacheControl) {
      res.setHeader('Cache-Control', options.cacheControl);
    }
    res.setHeader('Vary', 'Accept-Encoding, Authorization');

    // Try cache first.
    let cached: { etag: string; body: unknown } | null = null;
    try {
      cached = await this.cache.get<{ etag: string; body: unknown }>(key);
    } catch (err: any) {
      this.logger.warn(`cache lookup failed: ${err?.message || err}`);
    }

    if (cached) {
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === cached.etag) {
        // Conditional GET hit — body unchanged since client last fetched.
        res.setHeader('ETag', cached.etag);
        res.setHeader('X-Cache', 'HIT-304');
        res.status(304).end();
        // Returning an empty observable so Nest knows the response is sent.
        return of(undefined);
      }
      res.setHeader('ETag', cached.etag);
      res.setHeader('X-Cache', 'HIT');
      return of(cached.body);
    }

    // Cache miss — run handler then store the result.
    res.setHeader('X-Cache', 'MISS');
    return next.handle().pipe(
      tap(async (body) => {
        if (body === undefined) return;
        try {
          const json = JSON.stringify(body);
          const etag = `"${createHash('sha1').update(json).digest('hex')}"`;
          res.setHeader('ETag', etag);
          await this.cache.set(key, { etag, body }, ttl);
        } catch (err: any) {
          // Cache-write failure is non-fatal; the response is still sent.
          this.logger.warn(`cache write failed: ${err?.message || err}`);
        }
      }),
    );
  }
}
