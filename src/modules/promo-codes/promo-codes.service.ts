import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { PromoCode, PromoType } from './promo-code.entity';
import { PromoCodeUsage } from './promo-code-usage.entity';
import { AdminAuditLog } from '../admin/admin-audit.entity';
import { AnalyticsService } from '../analytics/analytics.service';
import {
  CreatePromoCodeDto,
  UpdatePromoCodeDto,
  ValidatePromoCodeDto,
} from './dto/promo-code.dto';
import { User } from '../users/user.entity';

/**
 * Lightweight metadata carried from the controller into the service so
 * we can record IP / UA on the admin audit row without coupling the
 * service to the Express Request type.
 */
export interface PromoAuditMeta {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class PromoCodesService {
  private readonly logger = new Logger(PromoCodesService.name);

  constructor(
    @InjectRepository(PromoCode)
    private promoRepo: Repository<PromoCode>,
    @InjectRepository(PromoCodeUsage)
    private usageRepo: Repository<PromoCodeUsage>,
    // The audit-log table is owned by AdminModule but it's a plain
    // entity, so we just register it on this module's TypeORM feature
    // to inject the repository here. Avoids a circular dep with
    // AdminService.
    @InjectRepository(AdminAuditLog)
    private auditRepo: Repository<AdminAuditLog>,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Single audit-log helper. Mirrors AdminService.audit() so the rows
   * for `promo.*` actions are queryable in the same UI.
   */
  private async writeAudit(
    admin: User | null,
    action: string,
    targetId: string | null,
    details: Record<string, any>,
    meta: PromoAuditMeta,
  ): Promise<void> {
    try {
      await this.auditRepo.save(
        this.auditRepo.create({
          admin_user_id: admin?.id ?? null,
          admin_name: admin?.name ?? null,
          action,
          target_type: 'promo_code',
          target_id: targetId,
          details,
          ip_address: meta.ip,
          user_agent: meta.userAgent,
        }),
      );
    } catch (err: any) {
      // Audit write must NEVER block the action. Log and move on.
      this.logger.error(
        `Failed to write audit row for ${action}: ${err?.message || err}`,
      );
    }
  }

  // ─── ADMIN: Create a promo code ───────────────────────
  async create(
    dto: CreatePromoCodeDto,
    admin: User,
    meta: PromoAuditMeta,
  ): Promise<PromoCode> {
    const upperCode = dto.code.toUpperCase();
    const existing = await this.promoRepo.findOne({
      where: { code: upperCode },
    });
    if (existing) throw new ConflictException('Promo code already exists');

    // PERCENTAGE rules: value must be 0..100; FLAT/FREE_VISIT: any non-neg.
    if (dto.type === PromoType.PERCENTAGE && (dto.value < 0 || dto.value > 100)) {
      throw new BadRequestException(
        'Percentage promo value must be between 0 and 100.',
      );
    }

    const promo = this.promoRepo.create({
      ...dto,
      code: upperCode,
      // Tolerate "" empty-string from the form; the column is nullable.
      expires_at: dto.expires_at ? new Date(dto.expires_at) : null,
    });

    const saved = await this.promoRepo.save(promo);

    await this.writeAudit(
      admin,
      'promo.create',
      saved.id,
      {
        code: saved.code,
        type: saved.type,
        value: saved.value,
        expires_at: saved.expires_at,
      },
      meta,
    );
    this.analytics
      .track({
        event_type: 'admin_promo_created',
        user_id: admin?.id ?? null,
        user_role: 'admin',
        metadata: {
          promo_id: saved.id,
          code: saved.code,
          type: saved.type,
        },
        ip_address: meta.ip,
        user_agent: meta.userAgent,
      })
      .catch((): void => undefined);

    return saved;
  }

  // ─── ADMIN: List all promo codes ──────────────────────
  /**
   * Optional `status` filter:
   *   active   — is_active=true AND (expires_at IS NULL OR expires_at > now)
   *               AND (max_uses IS NULL OR used_count < max_uses)
   *   inactive — is_active=false
   *   expired  — expires_at <= now (regardless of is_active)
   *   exhausted— used_count >= max_uses
   *
   * Without a filter the admin gets every promo, newest first.
   */
  async findAll(status?: string): Promise<PromoCode[]> {
    const qb = this.promoRepo.createQueryBuilder('p').orderBy('p.created_at', 'DESC');
    if (status === 'active') {
      qb.andWhere('p.is_active = true')
        .andWhere('(p.expires_at IS NULL OR p.expires_at > NOW())')
        .andWhere('(p.max_uses IS NULL OR p.used_count < p.max_uses)');
    } else if (status === 'inactive') {
      qb.andWhere('p.is_active = false');
    } else if (status === 'expired') {
      qb.andWhere('p.expires_at IS NOT NULL').andWhere('p.expires_at <= NOW()');
    } else if (status === 'exhausted') {
      qb.andWhere('p.max_uses IS NOT NULL').andWhere('p.used_count >= p.max_uses');
    }
    return qb.getMany();
  }

  // ─── ADMIN: Get one promo code ────────────────────────
  async findOne(id: string): Promise<PromoCode> {
    const promo = await this.promoRepo.findOne({ where: { id } });
    if (!promo) throw new NotFoundException('Promo code not found');
    return promo;
  }

  // ─── ADMIN: Update a promo code ──────────────────────
  /**
   * Edits any field except `code`. `code` is immutable — see DTO comment.
   */
  async update(
    id: string,
    dto: UpdatePromoCodeDto,
    admin: User,
    meta: PromoAuditMeta,
  ): Promise<PromoCode> {
    const promo = await this.findOne(id);
    const before = {
      type: promo.type,
      value: promo.value,
      max_discount: promo.max_discount,
      min_order_amount: promo.min_order_amount,
      single_use: promo.single_use,
      max_uses: promo.max_uses,
      expires_at: promo.expires_at,
      description: promo.description,
      is_active: promo.is_active,
    };

    if (dto.type === PromoType.PERCENTAGE && dto.value != null) {
      if (dto.value < 0 || dto.value > 100) {
        throw new BadRequestException(
          'Percentage promo value must be between 0 and 100.',
        );
      }
    }

    Object.assign(promo, dto);
    if (dto.expires_at !== undefined) {
      promo.expires_at = dto.expires_at ? new Date(dto.expires_at) : null;
    }

    const saved = await this.promoRepo.save(promo);

    await this.writeAudit(
      admin,
      'promo.update',
      saved.id,
      { code: saved.code, before, after: dto },
      meta,
    );

    return saved;
  }

  // ─── ADMIN: Toggle active status ─────────────────────
  async toggle(
    id: string,
    admin: User,
    meta: PromoAuditMeta,
  ): Promise<PromoCode> {
    const promo = await this.findOne(id);
    promo.is_active = !promo.is_active;
    const saved = await this.promoRepo.save(promo);

    await this.writeAudit(
      admin,
      'promo.toggle',
      saved.id,
      { code: saved.code, is_active: saved.is_active },
      meta,
    );

    return saved;
  }

  // ─── ADMIN: Delete a promo code ──────────────────────
  /**
   * Hard-delete is allowed ONLY when the promo has never been used,
   * so we don't orphan analytics or break the customer's "you used
   * promo X" history. If `used_count > 0` we surface a 409 with a
   * clear message asking the admin to deactivate instead. The UI
   * surfaces both options.
   */
  async remove(
    id: string,
    admin: User,
    meta: PromoAuditMeta,
  ): Promise<{ deleted: boolean; message: string }> {
    const promo = await this.findOne(id);
    if (promo.used_count > 0) {
      throw new ConflictException(
        `Promo code "${promo.code}" has been used ${promo.used_count} time(s) ` +
          `and cannot be deleted. Deactivate it instead to stop new redemptions.`,
      );
    }

    await this.promoRepo.remove(promo);

    await this.writeAudit(
      admin,
      'promo.delete',
      id,
      { code: promo.code, type: promo.type, value: promo.value },
      meta,
    );
    this.analytics
      .track({
        event_type: 'admin_promo_deleted',
        user_id: admin?.id ?? null,
        user_role: 'admin',
        metadata: { promo_id: id, code: promo.code },
        ip_address: meta.ip,
        user_agent: meta.userAgent,
      })
      .catch((): void => undefined);

    return { deleted: true, message: `Promo code "${promo.code}" deleted.` };
  }

  // ─── ADMIN: List who used a promo ────────────────────
  async listUsages(
    promoId: string,
    page = 1,
    limit = 50,
  ): Promise<{
    promo: PromoCode;
    usages: any[];
    pagination: { page: number; limit: number; total: number; total_pages: number };
  }> {
    const promo = await this.findOne(promoId);
    const skip = (page - 1) * limit;

    const [rows, total] = await this.usageRepo.findAndCount({
      where: { promo_code_id: promoId },
      order: { used_at: 'DESC' },
      skip,
      take: limit,
    });

    // The usage rows reference users + bookings by id only. Hydrate
    // names in a single query rather than letting the UI fan-out
    // dozens of GETs.
    const userIds = Array.from(new Set(rows.map((r) => r.user_id))).filter(Boolean);
    let userMap = new Map<string, { name: string; email: string }>();
    if (userIds.length > 0) {
      const users = await this.usageRepo.query(
        `SELECT id, name, email FROM users WHERE id = ANY($1::uuid[])`,
        [userIds],
      );
      userMap = new Map(users.map((u: any) => [u.id, { name: u.name, email: u.email }]));
    }

    const usages = rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      user_name: userMap.get(r.user_id)?.name ?? null,
      user_email: userMap.get(r.user_id)?.email ?? null,
      booking_id: r.booking_id,
      discount_applied: Number(r.discount_applied),
      used_at: r.used_at,
    }));

    return {
      promo,
      usages,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    };
  }

  // ─── CUSTOMER: Validate promo code ───────────────────
  async validate(
    userId: string,
    dto: ValidatePromoCodeDto,
  ): Promise<{
    valid: boolean;
    discount: number;
    final_amount: number;
    promo: Partial<PromoCode>;
    message: string;
  }> {
    const promo = await this.promoRepo.findOne({
      where: { code: dto.code.toUpperCase(), is_active: true },
    });

    if (!promo) {
      throw new BadRequestException('Invalid or expired promo code');
    }

    // Check expiry
    if (promo.expires_at && new Date() > promo.expires_at) {
      throw new BadRequestException('This promo code has expired');
    }

    // Check global usage cap
    if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
      throw new BadRequestException('This promo code has reached its usage limit');
    }

    // Check single-use per user
    if (promo.single_use) {
      const alreadyUsed = await this.usageRepo.findOne({
        where: { promo_code_id: promo.id, user_id: userId },
      });
      if (alreadyUsed) {
        throw new BadRequestException('You have already used this promo code');
      }
    }

    // Check minimum order
    if (dto.order_amount < Number(promo.min_order_amount)) {
      throw new BadRequestException(
        `Minimum order amount of ₹${promo.min_order_amount} required for this promo`,
      );
    }

    // Calculate discount
    const discount = this.calculateDiscount(promo, dto.order_amount);
    const final_amount = Math.max(0, dto.order_amount - discount);

    return {
      valid: true,
      discount,
      final_amount,
      promo: {
        id: promo.id,
        code: promo.code,
        type: promo.type,
        value: promo.value,
        description: promo.description,
      },
      message: `Promo applied! You save ₹${discount.toFixed(0)}`,
    };
  }

  // ─── INTERNAL: Record usage after booking confirmed ──
  /**
   * Records a redemption of `promoId` by `userId` against `bookingId`.
   *
   * If `manager` is provided, the usage row is written through it so
   * the caller can wrap the booking-save + usage insert in a single
   * transaction (see bookings.service.ts createBooking flow). The
   * `used_count` increment is intentionally OUTSIDE the transaction —
   * if the increment fails, the row in promo_code_usages is the
   * authoritative redemption record (the single_use check reads it,
   * not used_count), and the global counter being off by 1 is
   * recoverable by an admin SQL fix-up rather than a partial
   * customer-facing failure.
   */
  async recordUsage(
    promoId: string,
    userId: string,
    bookingId: string,
    discountApplied: number,
    manager?: EntityManager,
  ): Promise<void> {
    const usageRepo = manager
      ? manager.getRepository(PromoCodeUsage)
      : this.usageRepo;
    const usage = usageRepo.create({
      promo_code_id: promoId,
      user_id: userId,
      booking_id: bookingId,
      discount_applied: discountApplied,
    });
    await usageRepo.save(usage);

    // used_count increment is best-effort. If the caller passed a manager
    // it's still scoped to that transaction; otherwise it's a separate
    // statement.
    const promoRepo = manager
      ? manager.getRepository(PromoCode)
      : this.promoRepo;
    await promoRepo.increment({ id: promoId }, 'used_count', 1);
  }

  // ─── INTERNAL: Calculate discount amount ─────────────
  calculateDiscount(promo: PromoCode, orderAmount: number): number {
    let discount = 0;

    if (promo.type === PromoType.FLAT) {
      discount = Number(promo.value);
    } else if (promo.type === PromoType.PERCENTAGE) {
      discount = (orderAmount * Number(promo.value)) / 100;
      if (promo.max_discount) {
        discount = Math.min(discount, Number(promo.max_discount));
      }
    } else if (promo.type === PromoType.FREE_VISIT) {
      // Visit fee waived — handled in booking service; return 0 here
      discount = 0;
    }

    return Math.round(discount * 100) / 100;
  }
}
