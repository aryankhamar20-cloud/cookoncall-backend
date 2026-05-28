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
    // Connection pool — bumped from 5 → 20 to handle ~10k concurrent users
    // without queuing. Supabase Session Pooler default cap per service is 60,
    // so 20 leaves plenty of headroom for migrations / cron jobs.
    max: 20,
    min: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Kill any single query that runs longer than 30s — runaway joins or a
    // missing index will be cancelled before they exhaust the pool.
    statement_timeout: 30_000,
    // Keepalive to prevent Supabase Session Pooler from dropping idle connections
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  },
  // TypeORM retry settings
  retryAttempts: 5,
  retryDelay: 3000,
  logging: false,
});
