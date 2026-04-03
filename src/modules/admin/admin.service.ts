import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { User, UserRole } from '../users/user.entity';
import { Cook } from '../cooks/cook.entity';
import { Booking, BookingStatus } from '../bookings/booking.entity';
import { Payment, PaymentStatus } from '../payments/payment.entity';

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
      where: { is_verified: false },
    });

    const totalBookings = await this.bookingsRepository.count();
    const completedBookings = await this.bookingsRepository.count({
      where: { status: BookingStatus.COMPLETED },
    });
    const activeBookings = await this.bookingsRepository.count({
      where: [
        { status: BookingStatus.PENDING },
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

  // ─── VERIFY / REJECT COOK ────────────────────────────
  async verifyCook(cookId: string, verified: boolean) {
    const cook = await this.cooksRepository.findOne({
      where: { id: cookId },
    });

    if (!cook) {
      throw new NotFoundException('Cook not found');
    }

    cook.is_verified = verified;
    await this.cooksRepository.save(cook);

    return { message: verified ? 'Cook verified' : 'Cook rejected', cook };
  }

  // ─── BLOCK / UNBLOCK USER ─────────────────────────────
  async toggleUserActive(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.ADMIN) {
      throw new BadRequestException('Cannot block an admin');
    }

    user.is_active = !user.is_active;
    await this.usersRepository.save(user);

    return {
      message: user.is_active ? 'User unblocked' : 'User blocked',
      is_active: user.is_active,
    };
  }

  // ─── GET ALL BOOKINGS ─────────────────────────────────
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

    if (status) {
      qb.andWhere('b.status = :status', { status });
    }

    if (search) {
      qb.andWhere('(u.name ILIKE :search OR cu.name ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    const [bookings, total] = await qb.getManyAndCount();

    return {
      bookings,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── UPDATE BOOKING STATUS (admin override) ───────────
  async updateBookingStatus(bookingId: string, status: BookingStatus) {
    const booking = await this.bookingsRepository.findOne({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    booking.status = status;

    const now = new Date();
    if (status === BookingStatus.COMPLETED) booking.completed_at = now;
    if (
      status === BookingStatus.CANCELLED_BY_USER ||
      status === BookingStatus.CANCELLED_BY_COOK
    )
      booking.cancelled_at = now;

    await this.bookingsRepository.save(booking);

    return booking;
  }

  // ─── GET RECENT USERS ─────────────────────────────────
  async getRecentUsers(limit = 5) {
    return this.usersRepository.find({
      order: { created_at: 'DESC' },
      take: limit,
    });
  }

  // ─── GET RECENT BOOKINGS ──────────────────────────────
  async getRecentBookings(limit = 5) {
    return this.bookingsRepository.find({
      relations: ['user', 'cook', 'cook.user'],
      order: { created_at: 'DESC' },
      take: limit,
    });
  }
}
