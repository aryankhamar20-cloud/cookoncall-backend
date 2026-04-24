import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { User, UserRole } from '../users/user.entity';
import { Cook, VerificationStatus } from '../cooks/cook.entity';
import { Booking, BookingStatus } from '../bookings/booking.entity';
import { Payment, PaymentStatus } from '../payments/payment.entity';
import { Review } from '../reviews/review.entity';
import { Notification } from '../notifications/notification.entity';
import { AdminAuditLog } from './admin-audit.entity';
import { NotificationsService } from '../notifications/notifications.service';

type AuditMeta = { ip: string | null; userAgent: string | null };

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Cook)
    private cooksRepository: Repository<Cook>,
    @InjectRepository(Booking)
    private bookingsRepository: Repository<Booking>,
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    @InjectRepository(Review)
    private reviewsRepository: Repository<Review>,
    @InjectRepository(Notification)
    private notificationsRepository: Repository<Notification>,
    @InjectRepository(AdminAuditLog)
    private auditRepository: Repository<AdminAuditLog>,
    private notificationsService: NotificationsService,
  ) {}

  // ─── AUDIT HELPER ─────────────────────────────────────
  private async audit(
    admin: User | null,
    action: string,
    targetType: string,
    targetId: string | null,
    details: Record<string, any> = {},
    meta: AuditMeta = { ip: null, userAgent: null },
  ) {
    try {
      const row = this.auditRepository.create({
        admin_user_id: admin?.id || null,
        admin_name: admin?.name || null,
        action,
        target_type: targetType,
        target_id: targetId,
        details,
        ip_address: meta.ip,
        user_agent: meta.userAgent,
      });
      await this.auditRepository.save(row);
    } catch (err: any) {
      // Never let audit-log failure block a real admin action.
      this.logger.error(
        `Failed to write audit log (${action} ${targetType}:${targetId}): ${err?.message || err}`,
      );
    }
  }

  // ─── GET AUDIT LOG ────────────────────────────────────
  async getAuditLog(
    page = 1,
    limit = 50,
    action?: string,
    targetType?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (action) where.action = action;
    if (targetType) where.target_type = targetType;

    const [logs, total] = await this.auditRepository.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip,
      take: limit,
    });

    return {
      logs,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── DASHBOARD STATS ──────────────────────────────────
  async getStats() {
    const totalUsers = await this.usersRepository.count({
      where: { role: UserRole.USER },
    });

    const totalCooks = await this.cooksRepository.count();
    const verifiedCooks = await this.cooksRepository.count({
      where: { is_verified: true },
    });
    const pendingCooks = await this.cooksRepository.count({
      where: { verification_status: VerificationStatus.PENDING },
    });

    const totalBookings = await this.bookingsRepository.count();
    const completedBookings = await this.bookingsRepository.count({
      where: { status: BookingStatus.COMPLETED },
    });
    const activeBookings = await this.bookingsRepository.count({
      where: [
        { status: BookingStatus.PENDING_CHEF_APPROVAL },
        { status: BookingStatus.AWAITING_PAYMENT },
        { status: BookingStatus.PENDING }, // legacy
        { status: BookingStatus.CONFIRMED },
        { status: BookingStatus.IN_PROGRESS },
      ],
    });

    const revenueResult = await this.paymentsRepository
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.platform_fee), 0)', 'revenue')
      .where('p.status = :status', { status: PaymentStatus.CAPTURED })
      .getRawOne();

    return {
      total_users: totalUsers,
      total_cooks: totalCooks,
      verified_cooks: verifiedCooks,
      pending_cooks: pendingCooks,
      total_bookings: totalBookings,
      completed_bookings: completedBookings,
      active_bookings: activeBookings,
      total_revenue: parseFloat(revenueResult?.revenue || '0'),
    };
  }

  // ─── GET ALL USERS ────────────────────────────────────
  async getUsers(search?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const where: any = {};
    if (search) {
      where.name = ILike(`%${search}%`);
    }

    const [users, total] = await this.usersRepository.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip,
      take: limit,
    });

    return {
      users,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── UPDATE USER (admin edit) ─────────────────────────
  async updateUser(
    userId: string,
    updates: { name?: string; email?: string; phone?: string; role?: string },
    admin?: User,
    meta: AuditMeta = { ip: null, userAgent: null },
  ) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.ADMIN && updates.role && updates.role !== 'admin') {
      throw new BadRequestException('Cannot change admin role');
    }

    // Snapshot "before" for audit
    const before = {
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
    };

    if (updates.name !== undefined) user.name = updates.name;
    if (updates.email !== undefined) user.email = updates.email;
    if (updates.phone !== undefined) user.phone = updates.phone;
    if (updates.role !== undefined) {
      const safeRole = updates.role as UserRole;
      if (!Object.values(UserRole).includes(safeRole)) {
        throw new BadRequestException('Invalid role');
      }
      user.role = safeRole;
    }

    await this.usersRepository.save(user);

    await this.audit(
      admin || null,
      'user.update',
      'user',
      userId,
      { before, after: updates },
      meta,
    );

    return { message: 'User updated', user };
  }

  // ─── DELETE USER (cascade) ────────────────────────────
  async deleteUser(
    userId: string,
    admin?: User,
    meta: AuditMeta = { ip: null, userAgent: null },
  ) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.ADMIN) {
      throw new BadRequestException('Cannot delete an admin account');
    }

    // Audit BEFORE delete — so we still have snapshot if anything fails mid-cascade
    await this.audit(
      admin || null,
      'user.delete',
      'user',
      userId,
      {
        snapshot: {
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
      },
      meta,
    );

    await this.notificationsRepository.delete({ user_id: userId });
    await this.reviewsRepository.delete({ user_id: userId });

    const userBookings = await this.bookingsRepository.find({
      where: { user_id: userId },
    });

    for (const booking of userBookings) {
      await this.paymentsRepository.delete({ booking_id: booking.id });
      await this.reviewsRepository.delete({ booking_id: booking.id });
    }

    await this.bookingsRepository.delete({ user_id: userId });

    const cook = await this.cooksRepository.findOne({
      where: { user_id: userId },
    });

    if (cook) {
      await this.reviewsRepository.delete({ cook_id: cook.id });
      const cookBookings = await this.bookingsRepository.find({
        where: { cook_id: cook.id },
      });
      for (const booking of cookBookings) {
        await this.paymentsRepository.delete({ booking_id: booking.id });
        await this.reviewsRepository.delete({ booking_id: booking.id });
      }
      await this.bookingsRepository.delete({ cook_id: cook.id });
      await this.cooksRepository.delete({ id: cook.id });
    }

    await this.usersRepository.delete({ id: userId });
    return { message: `User "${user.name}" and all related data deleted` };
  }

  // ─── GET ALL COOKS ────────────────────────────────────
  async getCooks(verified?: boolean, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const where: any = {};
    if (verified !== undefined) {
      where.is_verified = verified;
    }

    const [cooks, total] = await this.cooksRepository.findAndCount({
      where,
      relations: ['user'],
      order: { created_at: 'DESC' },
      skip,
      take: limit,
    });

    return {
      cooks,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── GET PENDING VERIFICATION COOKS ───────────────────
  async getPendingVerifications(page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [cooks, total] = await this.cooksRepository.findAndCount({
      where: { verification_status: VerificationStatus.PENDING },
      relations: ['user'],
      order: { created_at: 'ASC' }, // oldest first
      skip,
      take: limit,
    });

    return {
      cooks,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── VERIFY / REJECT COOK ────────────────────────────
  async verifyCook(
    cookId: string,
    verified: boolean,
    rejectionReason?: string,
    admin?: User,
    meta: AuditMeta = { ip: null, userAgent: null },
  ) {
    const cook = await this.cooksRepository.findOne({
      where: { id: cookId },
      relations: ['user'],
    });

    if (!cook) {
      throw new NotFoundException('Cook not found');
    }

    if (verified) {
      cook.is_verified = true;
      cook.verification_status = VerificationStatus.APPROVED;
      cook.verified_at = new Date();
      cook.verification_rejection_reason = null;
      await this.cooksRepository.save(cook);

      await this.audit(
        admin || null,
        'cook.verify',
        'cook',
        cookId,
        { cook_name: cook.user?.name || null },
        meta,
      );

      // Notify chef
      if (cook.user_id) {
        this.notificationsService
          .notifyCookVerified(cook.user_id)
          .catch(() => {});
      }

      return { message: 'Cook verified successfully', cook };
    } else {
      cook.is_verified = false;
      cook.verification_status = VerificationStatus.REJECTED;
      cook.verification_rejection_reason = rejectionReason || null;
      await this.cooksRepository.save(cook);

      await this.audit(
        admin || null,
        'cook.reject',
        'cook',
        cookId,
        {
          cook_name: cook.user?.name || null,
          rejection_reason: rejectionReason || null,
        },
        meta,
      );

      // Notify chef
      if (cook.user_id) {
        this.notificationsService
          .notifyCookRejected(cook.user_id, rejectionReason)
          .catch(() => {});
      }

      return { message: 'Cook verification rejected', cook };
    }
  }

  // ─── DELETE COOK (cascade) ────────────────────────────
  async deleteCook(
    cookId: string,
    admin?: User,
    meta: AuditMeta = { ip: null, userAgent: null },
  ) {
    const cook = await this.cooksRepository.findOne({
      where: { id: cookId },
      relations: ['user'],
    });

    if (!cook) {
      throw new NotFoundException('Cook not found');
    }

    await this.audit(
      admin || null,
      'cook.delete',
      'cook',
      cookId,
      { cook_name: cook.user?.name || null, user_id: cook.user_id },
      meta,
    );

    await this.reviewsRepository.delete({ cook_id: cookId });
    const cookBookings = await this.bookingsRepository.find({
      where: { cook_id: cookId },
    });
    for (const booking of cookBookings) {
      await this.paymentsRepository.delete({ booking_id: booking.id });
      await this.reviewsRepository.delete({ booking_id: booking.id });
    }
    await this.bookingsRepository.delete({ cook_id: cookId });
    await this.cooksRepository.delete({ id: cookId });

    if (cook.user) {
      cook.user.role = UserRole.USER;
      await this.usersRepository.save(cook.user);
    }

    return { message: `Cook profile deleted, user "${cook.user?.name}" reverted to regular user` };
  }

  // ─── BLOCK / UNBLOCK USER ────────────────────────────
  async toggleUserActive(
    userId: string,
    admin?: User,
    meta: AuditMeta = { ip: null, userAgent: null },
  ) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === UserRole.ADMIN) throw new BadRequestException('Cannot block an admin');

    user.is_active = !user.is_active;
    await this.usersRepository.save(user);

    await this.audit(
      admin || null,
      user.is_active ? 'user.unblock' : 'user.block',
      'user',
      userId,
      { user_name: user.name },
      meta,
    );

    return { message: user.is_active ? 'User unblocked' : 'User blocked', is_active: user.is_active };
  }

  // ─── GET ALL BOOKINGS ────────────────────────────────
  async getBookings(status?: BookingStatus, search?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const qb = this.bookingsRepository
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.user', 'u')
      .leftJoinAndSelect('b.cook', 'c')
      .leftJoinAndSelect('c.user', 'cu')
      .orderBy('b.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    if (status) qb.andWhere('b.status = :status', { status });
    if (search) {
      qb.andWhere('(u.name ILIKE :search OR cu.name ILIKE :search)', { search: `%${search}%` });
    }

    const [bookings, total] = await qb.getManyAndCount();
    return {
      bookings,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── UPDATE BOOKING STATUS ────────────────────────────
  async updateBookingStatus(
    bookingId: string,
    status: BookingStatus,
    admin?: User,
    meta: AuditMeta = { ip: null, userAgent: null },
  ) {
    const booking = await this.bookingsRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    const previousStatus = booking.status;
    booking.status = status;
    const now = new Date();
    if (status === BookingStatus.COMPLETED) booking.completed_at = now;
    if (status === BookingStatus.CANCELLED_BY_USER || status === BookingStatus.CANCELLED_BY_COOK) {
      booking.cancelled_at = now;
    }

    await this.bookingsRepository.save(booking);

    await this.audit(
      admin || null,
      'booking.update_status',
      'booking',
      bookingId,
      { from: previousStatus, to: status },
      meta,
    );

    return booking;
  }

  // ─── DELETE BOOKING (cascade) ─────────────────────────
  async deleteBooking(
    bookingId: string,
    admin?: User,
    meta: AuditMeta = { ip: null, userAgent: null },
  ) {
    const booking = await this.bookingsRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    await this.audit(
      admin || null,
      'booking.delete',
      'booking',
      bookingId,
      {
        snapshot: {
          status: booking.status,
          total_price: booking.total_price,
          user_id: booking.user_id,
          cook_id: booking.cook_id,
        },
      },
      meta,
    );

    await this.paymentsRepository.delete({ booking_id: bookingId });
    await this.reviewsRepository.delete({ booking_id: bookingId });
    await this.bookingsRepository.delete({ id: bookingId });
    return { message: 'Booking deleted' };
  }

  // ─── GET RECENT USERS ────────────────────────────────
  async getRecentUsers(limit = 5) {
    return this.usersRepository.find({ order: { created_at: 'DESC' }, take: limit });
  }

  // ─── GET RECENT BOOKINGS ─────────────────────────────
  async getRecentBookings(limit = 5) {
    return this.bookingsRepository.find({
      relations: ['user', 'cook', 'cook.user'],
      order: { created_at: 'DESC' },
      take: limit,
    });
  }
}
