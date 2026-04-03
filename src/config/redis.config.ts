import { ConfigService } from '@nestjs/config';
import { BullModuleOptions } from '@nestjs/bull';

export const redisConfig = (
  configService: ConfigService,
): BullModuleOptions => {
  const redisUrl = configService.get<string>('REDIS_URL');

  if (redisUrl) {
    const url = new URL(redisUrl);
    return {
      redis: {
        host: url.hostname,
        port: parseInt(url.port, 10),
        password: url.password || undefined,
        tls: url.protocol === 'rediss:' ? {} : undefined,
      },
    };
  }

  return {
    redis: {
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      password: configService.get<string>('REDIS_PASSWORD'),
    },
  };
};
