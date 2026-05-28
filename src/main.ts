import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingMiddleware } from './common/middleware/logging.middleware';
import { seedAdmins } from './seed-admins';
import helmet from 'helmet';
import compression from 'compression';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  // Security
  app.use(helmet());
  app.use(compression());

  // ✅ P1: Request logging middleware
  app.use(new LoggingMiddleware().use.bind(new LoggingMiddleware()));

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

  // ✅ P0: Swagger/OpenAPI documentation
  // Accessible at /api/v1/docs in non-production
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('CookOnCall API')
      .setDescription('On-demand home cooking platform — complete REST API reference')
      .setVersion('1.0')
      .setContact('CookOnCall', 'https://thecookoncall.com', 'support@thecookoncall.com')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header' },
        'JWT',
      )
      .addTag('auth', 'Authentication — register, login, OTP, refresh, logout')
      .addTag('cooks', 'Chef profiles, menu, verification, earnings')
      .addTag('bookings', 'Booking lifecycle — create, accept, pay, OTP session')
      .addTag('payments', 'Razorpay payment flow')
      .addTag('reviews', 'Customer reviews & ratings')
      .addTag('notifications', 'In-app notifications')
      .addTag('addresses', 'Customer saved addresses')
      .addTag('availability', 'Chef availability scheduling')
      .addTag('meal-packages', 'Chef meal packages with categories & add-ons')
      .addTag('areas', 'Service areas & area requests')
      .addTag('admin', 'Admin-only management endpoints')
      .addTag('health', 'Health check')
      .addServer('http://localhost:4000', 'Local Development')
      .addServer('https://cookoncall-backend-production-7c6d.up.railway.app', 'Production (Railway)')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/v1/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
      customSiteTitle: 'CookOnCall API Docs',
    });

    new Logger('Swagger').log('📚 API docs available at /api/v1/docs');
  }

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
}
bootstrap();
