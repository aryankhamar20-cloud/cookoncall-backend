import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * TypeORM CLI datasource config.
 * Used only for: npm run migration:generate / migration:run / migration:revert
 * NOT used by NestJS at runtime (that uses databaseConfig via TypeOrmModule.forRootAsync)
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  entities: ['src/modules/**/*.entity.ts'],
  migrations: ['migrations/*.ts'],
  extra: { family: 4 },
});
