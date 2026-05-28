import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { seedAdmins } from './seed-admins';
import { setupSwagger } from './config/swagger.config';
import { initSentry } from './common/services/sentry.service';
import helmet from 'helmet';
import compression from 'compression';

async function bootstrap() {
  // ─── Sentry MUST init before NestFactory so it captures bootstrap errors ───
  initSentry();

  const app = await NestFactory.create(AppModule);

  // Security
  app.use(helmet({
    // Relax CSP for Swagger UI
    contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
  }));
  app.use(compression());

  // ─── CORS — exact-match allowlist (no broad wildcards) ───
  // Cloudflare Pages preview URLs use deterministic 8-char hex hashes,
  // so we allow ONLY <hex>.cookoncall.pages.dev and explicit branch previews.
  const exactAllowed = new Set<string>([
    'https://cookoncall.pages.dev',
    'https://thecookoncall.com',
    'https://www.thecookoncall.com',
  ]);
  if (process.env.NODE_ENV !== 'production') {
    exactAllowed.add(process.env.FRONTEND_URL || 'http://localhost:3000');
    exactAllowed.add('http://localhost:3000');
    exactAllowed.add('http://localhost:3001');
  }
  // Cloudflare Pages preview deployment URL pattern: <8-hex>.cookoncall.pages.dev
  const cfPreviewHash = /^https:\/\/[a-f0-9]{8}\.cookoncall\.pages\.dev$/;
  // Cloudflare Pages branch preview URL pattern: <branch-slug>.cookoncall.pages.dev
  // (branch slug = lowercase letters, digits, hyphens)
  const cfBranchPreview = /^https:\/\/[a-z0-9-]{1,63}\.cookoncall\.pages\.dev$/;

  app.enableCors({
    origin: (origin, callback) => {
      // Allow non-browser requests (mobile app, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (
        exactAllowed.has(origin) ||
        cfPreviewHash.test(origin) ||
        cfBranchPreview.test(origin)
      ) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked origin: ${origin}`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Swagger docs (available at /api/v1/docs)
  setupSwagger(app);

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
  new Logger('Bootstrap').log(
    `🚀 CookOnCall API running on http://localhost:${port}/api/v1`,
  );
  new Logger('Bootstrap').log(
    `📚 Swagger docs at http://localhost:${port}/api/v1/docs`,
  );
}
bootstrap();
