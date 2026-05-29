import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const databaseConfig = (configService: ConfigService): TypeOrmModuleOptions => {
  const isProd = configService.get<string>('NODE_ENV') === 'production';

  return {
    type: 'postgres' as const,
    url: configService.get<string>('DATABASE_URL'),
    autoLoadEntities: true,

    // ─── Schema management ────────────────────────────────
    // Dev: TypeORM auto-syncs schema → entity (fast iteration).
    // Prod: NEVER. Schema changes ship via TypeORM-managed migrations
    //       in src/migrations/ (compiled to dist/migrations/ at build time).
    //
    // TODO(migrations): once a real schema-changing migration ships
    // through the new system, flip dev to synchronize:false too so
    // dev → prod schema drift becomes impossible. Tracking issue: see
    // /MIGRATIONS.md "Phase 2 — disable synchronize in dev".
    synchronize: !isProd,

    // ─── Migrations ───────────────────────────────────────
    // Auto-run pending migrations on app boot in production, so a
    // Railway deploy is "code + schema" atomic — no manual psql step,
    // no chance of running app code against a stale schema. Dev runs
    // them manually via `npm run migration:run` because synchronize
    // is still on.
    migrations: ['dist/migrations/*.js'],
    migrationsRun: isProd,
    migrationsTableName: 'migrations',

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
  };
};
