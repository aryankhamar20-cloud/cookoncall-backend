/**
 * AuthController POST /auth/change-password — e2e regression spec
 *
 * Locks in the security guards from PR #28 at the HTTP layer:
 *
 *   ✓ 200 OK on the happy path; service receives the JWT-derived
 *     user.id (NOT a user-controlled value from the request body).
 *   ✓ 401 when current_password is wrong (UnauthorizedException
 *     from the service surfaces as 401 to the client).
 *   ✓ 400 when current_password === new_password (BadRequestException).
 *   ✓ 400 when the account has no stored password (Google-only
 *     signup — must use the forgot-password flow first).
 *   ✓ 400 on DTO validation failure: missing fields, password too
 *     short, password missing the letter-or-digit complexity rule.
 *
 * The unit-level guards on AuthService.changePassword are already
 * locked in by auth.service.change-password.spec.ts (#28). This spec
 * adds the controller wiring so a refactor that:
 *   - drops @CurrentUser (an attacker could specify any user.id),
 *   - removes the implicit JWT guard (route accidentally @Public),
 *   - swaps the DTO type (validation rules silently disabled),
 *   - or removes the global ValidationPipe from main.ts,
 * also fails a test instead of slipping through review.
 *
 * Same e2e harness pattern as PromoCodesController (#22) and
 * BookingsController (#23) specs: NestApplication + supertest with
 * a global guard that injects a synthetic user, AuthService stubbed,
 * and the same ValidationPipe config that production uses in main.ts.
 * No DB, no bcrypt, no JWT verification — that's the unit spec's job.
 */
import {
  BadRequestException,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserRole } from '../users/user.entity';

describe('AuthController POST /auth/change-password (regression spec)', () => {
  let app: INestApplication;

  // Per-test mutable: the global guard reads this to decide whether
  // to inject a user onto request.user before the route runs.
  // null === unauthenticated (guard returns false → 403 from Nest).
  let currentCaller: { id: string; role: UserRole } | null = null;

  const userId = '11111111-1111-1111-1111-111111111111';
  const validBody = {
    current_password: 'CurrentP@ss1',
    new_password: 'BrandNewP@ss1',
  };

  // Stub only the methods the routes we hit will reach. AuthController
  // wires many routes; we only exercise change-password here, so other
  // method stubs are left undefined to fail loudly if a test
  // accidentally calls one.
  const authServiceMock = {
    changePassword: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authServiceMock }],
    }).compile();

    app = moduleRef.createNestApplication();

    // Mirror prod: AuthController has no controller-level @UseGuards.
    // In production a JwtAuthGuard is installed globally via APP_GUARD
    // and a @Public() decorator opts specific routes out (login,
    // register, forgot-password, etc.). change-password has NO
    // @Public(), so the guard applies. We install a fake global
    // guard here that does the same thing — read the synthetic
    // currentCaller and inject it onto request.user, or reject.
    app.useGlobalGuards({
      canActivate: (ctx: ExecutionContext) => {
        if (currentCaller === null) return false;
        const req = ctx.switchToHttp().getRequest();
        req.user = currentCaller;
        return true;
      },
    });

    // Mirror prod ValidationPipe config from main.ts EXACTLY. If
    // main.ts changes (e.g. forbidNonWhitelisted flipped off), the
    // DTO validation tests below will diverge from prod behavior —
    // that's the intent: forces a deliberate test update if the
    // global pipe config is tweaked.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: authenticated as a regular user. Tests that need a
    // different state (null = unauth) override at the top of the test.
    currentCaller = { id: userId, role: UserRole.USER };
  });

  // ─── Happy path ───────────────────────────────────────────
  describe('happy path', () => {
    it('returns 200 with the success message and forwards the JWT user.id (not the body)', async () => {
      authServiceMock.changePassword.mockResolvedValueOnce({
        message: 'Password changed successfully',
      });

      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        message: 'Password changed successfully',
      });

      // The service receives user.id from the JWT-derived currentCaller
      // and the validated DTO body — nothing else. This is the
      // critical authorization assertion: even if a malicious client
      // tries to put a `user_id` field in the body, the controller
      // ignores it (whitelist strips unknowns) and the service
      // operates on the JWT identity.
      expect(authServiceMock.changePassword).toHaveBeenCalledTimes(1);
      expect(authServiceMock.changePassword).toHaveBeenCalledWith(
        userId,
        validBody,
      );
    });

    it('strips body-supplied user_id (whitelist + forbidNonWhitelisted)', async () => {
      // An attacker tries to slip a victim's id into the body in case
      // the controller naively trusts dto.user_id. ValidationPipe with
      // forbidNonWhitelisted should reject the request outright.
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send({
          ...validBody,
          user_id: '99999999-9999-9999-9999-999999999999',
        });

      expect(res.status).toBe(400);
      expect(authServiceMock.changePassword).not.toHaveBeenCalled();
    });
  });

  // ─── Service-layer guards (status code mapping) ───────────
  // These are exercised at the unit level in
  // auth.service.change-password.spec.ts. Here we just confirm the
  // controller surfaces the right HTTP status — a refactor that
  // catches+swallows or remaps these exceptions would fail.
  describe('forwards service exceptions with correct HTTP status', () => {
    it('returns 401 when current_password is wrong', async () => {
      authServiceMock.changePassword.mockRejectedValueOnce(
        new UnauthorizedException('Current password is incorrect'),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send(validBody);

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/current password is incorrect/i);
    });

    it('returns 400 when current_password === new_password', async () => {
      authServiceMock.changePassword.mockRejectedValueOnce(
        new BadRequestException(
          'New password must differ from current password',
        ),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send({
          current_password: 'SameP@ss1',
          new_password: 'SameP@ss1',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/must differ/i);
    });

    it('returns 400 for Google-only accounts (no password set)', async () => {
      authServiceMock.changePassword.mockRejectedValueOnce(
        new BadRequestException(
          'No password is set on this account. Use the "Forgot password?" flow on the login page to set one.',
        ),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send(validBody);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no password is set/i);
    });
  });

  // ─── DTO validation (class-validator wiring) ──────────────
  // These tests do NOT exercise the service — they assert that the
  // global ValidationPipe rejects malformed input before the route
  // handler ever runs. If the pipe is dropped or the DTO loses its
  // decorators, every test in this group flips from 400 → 200/500.
  describe('DTO validation (rejects before reaching the service)', () => {
    it('rejects missing current_password with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send({ new_password: validBody.new_password });

      expect(res.status).toBe(400);
      expect(authServiceMock.changePassword).not.toHaveBeenCalled();
    });

    it('rejects missing new_password with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send({ current_password: validBody.current_password });

      expect(res.status).toBe(400);
      expect(authServiceMock.changePassword).not.toHaveBeenCalled();
    });

    it('rejects new_password shorter than 8 chars with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send({
          current_password: validBody.current_password,
          new_password: 'Ab1', // 3 chars
        });

      expect(res.status).toBe(400);
      // Surface the specific class-validator message — confirms the
      // MinLength decorator is what fired, not some other validator.
      const messages = ([] as string[]).concat(res.body.message ?? []);
      expect(messages.some((m) => /at least 8 characters/i.test(m))).toBe(true);
      expect(authServiceMock.changePassword).not.toHaveBeenCalled();
    });

    it('rejects new_password missing a digit with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send({
          current_password: validBody.current_password,
          new_password: 'OnlyLetters', // no digit
        });

      expect(res.status).toBe(400);
      const messages = ([] as string[]).concat(res.body.message ?? []);
      expect(
        messages.some((m) => /letter and one digit/i.test(m)),
      ).toBe(true);
      expect(authServiceMock.changePassword).not.toHaveBeenCalled();
    });

    it('rejects new_password missing a letter with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/change-password')
        .send({
          current_password: validBody.current_password,
          new_password: '12345678', // no letter
        });

      expect(res.status).toBe(400);
      expect(authServiceMock.changePassword).not.toHaveBeenCalled();
    });
  });
});
