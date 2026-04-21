import {
  BadRequestException,
  Injectable,
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
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AdminService {
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
    private notificationsService: NotificationsService,
  ) {}

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
    return { message: 'User updated', user };
  }

  // ─── DELETE USER (cascade) ────────────────────────────
  async deleteUser(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.ADMIN) {
      throw new BadRequestException('Cannot delete an admin account');
    }

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
  async verifyCook(cookId: string, verified: boolean, rejectionReason?: string) {
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
  async deleteCook(cookId: string) {
    const cook = await this.cooksRepository.findOne({
      where: { id: cookId },
      relations: ['user'],
    });

    if (!cook) {
      throw new NotFoundException('Cook not found');
    }

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
  async toggleUserActive(userId: string) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === UserRole.ADMIN) throw new BadRequestException('Cannot block an admin');

    user.is_active = !user.is_active;
    await this.usersRepository.save(user);
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
  async updateBookingStatus(bookingId: string, status: BookingStatus) {
    const booking = await this.bookingsRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

    booking.status = status;
    const now = new Date();
    if (status === BookingStatus.COMPLETED) booking.completed_at = now;
    if (status === BookingStatus.CANCELLED_BY_USER || status === BookingStatus.CANCELLED_BY_COOK) {
      booking.cancelled_at = now;
    }

    await this.bookingsRepository.save(booking);
    return booking;
  }

  // ─── DELETE BOOKING (cascade) ─────────────────────────
  async deleteBooking(bookingId: string) {
    const booking = await this.bookingsRepository.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');

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
