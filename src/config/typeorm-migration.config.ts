import { DataSource, DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';
import { join } from 'path';

/**
 * ✅ P2: TypeORM DataSource config for CLI migrations.
 *
 * Used by:
 *   npx typeorm migration:generate src/migrations/MigrationName -d src/config/typeorm-migration.config.ts
 *   npx typeorm migration:run -d src/config/typeorm-migration.config.ts
 *   npx typeorm migration:revert -d src/config/typeorm-migration.config.ts
 *
 * NOTE: synchronize is DISABLED — all schema changes go through migrations.
 */
dotenv.config();

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  extra: {
    ssl: { rejectUnauthorized: false },
    family: 4,
  },
  // Load all entities from the modules
  entities: [join(__dirname, '../modules/**/*.entity.{ts,js}')],
  // Load migrations from the migrations folder
  migrations: [join(__dirname, '../../migrations/*.{ts,js}')],
  // ✅ IMPORTANT: synchronize OFF in production — use migrations instead
  synchronize: false,
  migrationsRun: false,
  logging: ['migration', 'error'],
};

const dataSource = new DataSource(dataSourceOptions);
export default dataSource;
