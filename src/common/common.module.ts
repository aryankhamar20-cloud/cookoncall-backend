import { Global, Module } from '@nestjs/common';
import { RedisCacheService } from './services/redis-cache.service';
import { ResponseCacheInterceptor } from './interceptors/response-cache.interceptor';
import { FcmService } from './services/fcm.service';

/**
 * Shared infrastructure providers — Redis cache + the response-cache
 * interceptor + FCM push-notification service. Marked @Global so feature
 * modules can use the `@CacheResponse` decorator + `RedisCacheService`
 * (for invalidation) and `FcmService` (for push) without explicitly
 * importing CommonModule.
 */
@Global()
@Module({
  providers: [RedisCacheService, ResponseCacheInterceptor, FcmService],
  exports: [RedisCacheService, ResponseCacheInterceptor, FcmService],
})
export class CommonModule {}
