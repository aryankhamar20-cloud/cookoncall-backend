import { INestApplication } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('CookOnCall API')
    .setDescription(
      'On-demand home cooking platform — REST API documentation.\n\n' +
      '**Auth:** Use the 🔒 Authorize button and paste your Bearer token.\n\n' +
      'Base URL: `https://cookoncall-backend-production-7c6d.up.railway.app/api/v1`',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        in: 'header',
      },
      'access-token',
    )
    .addTag('Health', 'API health check')
    .addTag('Auth', 'Authentication — register, login, OTP, refresh, logout')
    .addTag('Users', 'User profile and stats')
    .addTag('Cooks', 'Chef profiles, menu, search, verification')
    .addTag('Bookings', 'Booking lifecycle — create, accept, pay, OTP session')
    .addTag('Payments', 'Razorpay order creation and verification')
    .addTag('Reviews', 'Customer reviews for cooks')
    .addTag('Notifications', 'In-app notifications')
    .addTag('Addresses', 'Customer saved addresses')
    .addTag('Availability', 'Chef weekly schedule and date overrides')
    .addTag('Meal Packages', 'Pre-priced meal combo packages')
    .addTag('Areas', 'Service area management')
    .addTag('Uploads', 'File uploads (Cloudinary)')
    .addTag('Admin', 'Admin dashboard — users, cooks, bookings')
    .addTag('Promo Codes', 'Promo code management and validation')
    .addTag('Referrals', 'Referral system — codes and rewards')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/v1/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      docExpansion: 'none',
      filter: true,
      showRequestDuration: true,
    },
    customSiteTitle: 'CookOnCall API Docs',
    customCss: `
      .swagger-ui .topbar { background-color: #2C1810; }
      .swagger-ui .topbar-wrapper img { content: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><text y="15" font-size="14" fill="white" font-weight="bold">COOKONCALL</text></svg>'); }
      .swagger-ui .info .title { color: #2C1810; }
    `,
  });
}
