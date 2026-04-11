import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const databaseConfig = (configService: ConfigService): TypeOrmModuleOptions => ({
  type: 'postgres' as const,
  url: configService.get<string>('DATABASE_URL'),
  autoLoadEntities: true,
  synchronize: configService.get<string>('NODE_ENV') !== 'production',
  ssl: { rejectUnauthorized: false },
  extra: {
    ssl: { rejectUnauthorized: false },
    family: 4,
    // Connection pool settings
    max: 5,
    min: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Keepalive to prevent Supabase Session Pooler from dropping idle connections
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  },
  // TypeORM retry settings
  retryAttempts: 5,
  retryDelay: 3000,
  logging: false,
});
