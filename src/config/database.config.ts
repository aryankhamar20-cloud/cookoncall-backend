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
  },
  logging: false,
});
