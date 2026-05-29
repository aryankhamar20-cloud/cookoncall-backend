import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * TypeORM CLI datasource config.
 * Used only for: npm run migration:generate / migration:run / migration:revert
 * NOT used by NestJS at runtime (that uses databaseConfig via TypeOrmModule.forRootAsync).
 *
 * Path note:
 *   - entities + migrations are .ts here because the CLI runs via ts-node.
 *   - At runtime the equivalent paths under dist/ are used by
 *     databaseConfig (autoLoadEntities + migrations: ['dist/migrations/*.js']).
 *   - Legacy raw-SQL files in /migrations/legacy/ are explicitly NOT picked up;
 *     they are historical record (see migrations/legacy/README.md).
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  entities: ['src/modules/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
  extra: { family: 4 },
});
