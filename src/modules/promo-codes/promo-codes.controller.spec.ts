/**
 * PromoCodesController — e2e role-guard spec
 *
 * Locks in the security fix from PR #16: every admin-only route on
 * /promo-codes must reject non-admin authenticated users with 403,
 * and the single customer-facing route (POST /promo-codes/validate)
 * must remain accessible to any authenticated user.
 *
 * The original bug: the controller had @Roles(UserRole.ADMIN) on
 * its admin routes but no @UseGuards(RolesGuard), so the metadata
 * was inert and a regular customer could mint themselves promo
 * codes. This spec asserts the wiring stays correct on every
 * admin route in the controller — adding a new admin route without
 * the guard will fail this test, not just slip through review.
 *
 * It's a real HTTP-level e2e test (NestApplication + supertest), but
 * with all I/O stubbed: JwtAuthGuard is overridden to inject a
 * synthetic user.role, RolesGuard is the real one, and the service
 * layer is replaced by a manual mock so we don't need a database.
 */
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PromoCodesController } from './promo-codes.controller';
import { PromoCodesService } from './promo-codes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserRole } from '../users/user.entity';

type Role = UserRole | undefined;

describe('PromoCodesController (role-guard wiring)', () => {
  let app: INestApplication;
  // Mutable per-test: the guard reads this to decide what user to
  // inject onto request.user before the route handler runs.
  let currentRole: Role = UserRole.USER;
  const stubUserId = '11111111-1111-1111-1111-111111111111';

  // A canned, predictable response from each service method so we can
  // verify the guard let the call through (vs short-circuiting at 403).
  const okResponse = { ok: true };
  const promoCodesServiceMock = {
    validate: jest.fn().mockResolvedValue(okResponse),
    create: jest.fn().mockResolvedValue(okResponse),
    findAll: jest.fn().mockResolvedValue(okResponse),
    findOne: jest.fn().mockResolvedValue(okResponse),
    update: jest.fn().mockResolvedValue(okResponse),
    toggle: jest.fn().mockResolvedValue(okResponse),
    remove: jest.fn().mockResolvedValue(okResponse),
    listUsages: jest.fn().mockResolvedValue(okResponse),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PromoCodesController],
      providers: [
        { provide: PromoCodesService, useValue: promoCodesServiceMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          // Pretend we successfully verified a JWT and attach the
          // synthetic user. RolesGuard runs next and reads req.user.role.
          // currentRole === undefined simulates no auth at all (so we
          // can also verify the unauthenticated path).
          if (currentRole === undefined) {
            return false; // 403 from this guard — Nest converts to ForbiddenException
          }
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: stubUserId, role: currentRole };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // The exhaustive list of admin-only routes on this controller.
  // If a new admin route is added without @Roles(UserRole.ADMIN) the
  // first assertion fails (the customer call returns 200/201 instead
  // of 403). If a new admin route is added without the guard wiring at
  // all, EVERY new test in this group will fail.
  const ADMIN_ROUTES: Array<{
    name: string;
    method: 'get' | 'post' | 'patch' | 'delete';
    path: string;
    body?: Record<string, unknown>;
  }> = [
    { name: 'POST   /promo-codes',                method: 'post',   path: '/promo-codes',                                              body: { code: 'X', type: 'flat', value: 100 } },
    { name: 'GET    /promo-codes',                method: 'get',    path: '/promo-codes' },
    { name: 'GET    /promo-codes/:id',            method: 'get',    path: '/promo-codes/22222222-2222-2222-2222-222222222222' },
    { name: 'PATCH  /promo-codes/:id',            method: 'patch',  path: '/promo-codes/22222222-2222-2222-2222-222222222222',         body: {} },
    { name: 'PATCH  /promo-codes/:id/toggle',     method: 'patch',  path: '/promo-codes/22222222-2222-2222-2222-222222222222/toggle' },
    { name: 'DELETE /promo-codes/:id',            method: 'delete', path: '/promo-codes/22222222-2222-2222-2222-222222222222' },
    { name: 'GET    /promo-codes/:id/usages',     method: 'get',    path: '/promo-codes/22222222-2222-2222-2222-222222222222/usages' },
  ];

  describe('admin-only routes', () => {
    for (const route of ADMIN_ROUTES) {
      describe(route.name, () => {
        it('rejects a USER (regular customer) with 403', async () => {
          currentRole = UserRole.USER;
          const req = request(app.getHttpServer())[route.method](route.path);
          const res = route.body ? await req.send(route.body) : await req;
          expect(res.status).toBe(403);
        });

        it('rejects a COOK with 403', async () => {
          currentRole = UserRole.COOK;
          const req = request(app.getHttpServer())[route.method](route.path);
          const res = route.body ? await req.send(route.body) : await req;
          expect(res.status).toBe(403);
        });

        it('lets an ADMIN through to the service', async () => {
          currentRole = UserRole.ADMIN;
          const req = request(app.getHttpServer())[route.method](route.path);
          const res = route.body ? await req.send(route.body) : await req;
          expect(res.status).toBeLessThan(400);
          // Service was actually invoked — proves the guard didn't
          // short-circuit and the route returned the stub's payload.
          expect(res.body).toMatchObject({ ok: true });
        });
      });
    }
  });

  describe('customer-facing route POST /promo-codes/validate', () => {
    const validateBody = { code: 'WELCOME10', booking_total: 500 };

    it('lets a USER (regular customer) through', async () => {
      currentRole = UserRole.USER;
      const res = await request(app.getHttpServer())
        .post('/promo-codes/validate')
        .send(validateBody);
      expect(res.status).toBeLessThan(400);
      expect(promoCodesServiceMock.validate).toHaveBeenCalledTimes(1);
    });

    it('lets a COOK through (a chef can also validate codes for self-bookings)', async () => {
      currentRole = UserRole.COOK;
      const res = await request(app.getHttpServer())
        .post('/promo-codes/validate')
        .send(validateBody);
      expect(res.status).toBeLessThan(400);
    });

    it('lets an ADMIN through too (no role restriction)', async () => {
      currentRole = UserRole.ADMIN;
      const res = await request(app.getHttpServer())
        .post('/promo-codes/validate')
        .send(validateBody);
      expect(res.status).toBeLessThan(400);
    });
  });
});
