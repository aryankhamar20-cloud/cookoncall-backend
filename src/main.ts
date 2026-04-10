import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { seedAdmins } from './seed-admins';
import helmet from 'helmet';
import compression from 'compression';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security
  app.use(helmet());
  app.use(compression());

  // CORS
  app.enableCors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'https://cookoncall.pages.dev',
      'https://thecookoncall.com',
      'https://www.thecookoncall.com',
      /\.cookoncall\.pages\.dev$/,
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(new TransformInterceptor());

  // ─── Auto-seed admin accounts on startup ───
  // Idempotent: creates admins only if they don't exist. Safe to run on every
  // restart. Wrapped in try/catch so a seed failure never crashes the app.
  try {
    const dataSource = app.get(DataSource);
    await seedAdmins(dataSource);
  } catch (err) {
    new Logger('Bootstrap').error(
      `Admin seed skipped due to error: ${(err as Error).message}`,
    );
  }

  const port = process.env.PORT || 4000;
  await app.listen(port);
  console.log(`🚀 CookOnCall API running on http://localhost:${port}/api/v1`);
}
bootstrap();
