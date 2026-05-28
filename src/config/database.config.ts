import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const databaseConfig = (configService: ConfigService): TypeOrmModuleOptions => {
  const isProd = configService.get<string>('NODE_ENV') === 'production';

  return {
    type: 'postgres' as const,
    url: configService.get<string>('DATABASE_URL'),
    autoLoadEntities: true,
    // ✅ P2: Migrations — synchronize ONLY in dev to auto-create tables.
    // In production: run migrations manually via `npm run migration:run`.
    // This prevents accidental schema changes in production.
    synchronize: !isProd,
    // Run migrations automatically on startup in production
    migrationsRun: false, // Set to true to auto-run on deploy (optional)
    ssl: { rejectUnauthorized: false },
    extra: {
      ssl: { rejectUnauthorized: false },
      family: 4,
      max: isProd ? 10 : 5,
      min: 1,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    },
    retryAttempts: 5,
    retryDelay: 3000,
    logging: isProd ? ['error'] : false,
  };
};
