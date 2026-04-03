import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus, BookingType } from './booking.entity';
import { Cook } from '../cooks/cook.entity';
import { User } from '../users/user.entity';
import {
  CreateBookingDto,
  UpdateBookingStatusDto,
  GetBookingsDto,
} from './dto/booking.dto';

const PLATFORM_FEE_PERCENT = 0.15; // 15%

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    @InjectRepository(Booking)
    private bookingsRepository: Repository<Booking>,
    @InjectRepository(Cook)
    private cooksRepository: Repository<Cook>,
  ) {}

  // ─── CREATE BOOKING ───────────────────────────────────
  async createBooking(userId: string, dto: CreateBookingDto) {
    const cook = await this.cooksRepository.findOne({
      where: { id: dto.cook_id },
      relations: ['user'],
    });

    if (!cook) {
      throw new NotFoundException('Cook not found');
    }

    if (!cook.is_verified) {
      throw new BadRequestException('Cook is not yet verified');
    }

    if (!cook.is_available) {
      throw new BadRequestException('Cook is currently unavailable');
    }

    // Prevent self-booking
    if (cook.user_id === userId) {
      throw new BadRequestException('You cannot book yourself');
    }

    // Check scheduled date is in the future
    const scheduledDate = new Date(dto.scheduled_at);
    if (scheduledDate <= new Date()) {
      throw new BadRequestException('Scheduled date must be in the future');
    }

    // Calculate price
    let subtotal: number;

    if (dto.booking_type === BookingType.FOOD_DELIVERY && dto.order_items?.length) {
      // Sum up order items
      subtotal = dto.order_items.reduce(
        (sum, item) => sum + item.price * item.qty,
        0,
      );
    } else {
      // Home cooking — based on session price * duration
      const hours = dto.duration_hours || 2;
      subtotal = Number(cook.price_per_session) * hours;
    }

    const platformFee = Math.round(subtotal * PLATFORM_FEE_PERCENT * 100) / 100;
    const totalPrice = subtotal + platformFee;

    const booking = this.bookingsRepository.create({
      user_id: userId,
      cook_id: dto.cook_id,
      booking_type: dto.booking_type || BookingType.HOME_COOKING,
      scheduled_at: scheduledDate,
      duration_hours: dto.duration_hours || 2,
      guests: dto.guests || 2,
      address: dto.address,
      latitude: dto.latitude,
      longitude: dto.longitude,
      dishes: dto.dishes,
      instructions: dto.instructions,
      order_items: dto.order_items || null,
      subtotal,
      platform_fee: platformFee,
      total_price: totalPrice,
      status: BookingStatus.PENDING,
    });

    const saved = await this.bookingsRepository.save(booking);

    return this.findById(saved.id);
  }

  // ─── GET USER BOOKINGS ────────────────────────────────
  async getUserBookings(userId: string, dto: GetBookingsDto) {
    const page = dto.page || 1;
    const limit = dto.limit || 10;
    const skip = (page - 1) * limit;

    const qb = this.bookingsRepository
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.cook', 'c')
      .leftJoinAndSelect('c.user', 'cu')
      .where('b.user_id = :userId', { userId })
      .orderBy('b.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    if (dto.status) {
      qb.andWhere('b.status = :status', { status: dto.status });
    }

    const [bookings, total] = await qb.getManyAndCount();

    return {
      bookings,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── GET COOK BOOKINGS (REQUESTS) ─────────────────────
  async getCookBookings(userId: string, dto: GetBookingsDto) {
    // Find the cook profile by user_id
    const cook = await this.cooksRepository.findOne({
      where: { user_id: userId },
    });

    if (!cook) {
      throw new NotFoundException('Cook profile not found');
    }

    const page = dto.page || 1;
    const limit = dto.limit || 10;
    const skip = (page - 1) * limit;

    const qb = this.bookingsRepository
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.user', 'u')
      .where('b.cook_id = :cookId', { cookId: cook.id })
      .orderBy('b.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    if (dto.status) {
      qb.andWhere('b.status = :status', { status: dto.status });
    }

    const [bookings, total] = await qb.getManyAndCount();

    return {
      bookings,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── GET BOOKING BY ID ────────────────────────────────
  async findById(id: string) {
    const booking = await this.bookingsRepository.findOne({
      where: { id },
      relations: ['user', 'cook', 'cook.user'],
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    return booking;
  }

  // ─── UPDATE BOOKING STATUS ────────────────────────────
  async updateStatus(
    bookingId: string,
    userId: string,
    userRole: string,
    dto: UpdateBookingStatusDto,
  ) {
    const booking = await this.findById(bookingId);

    // Validate ownership
    const cook = await this.cooksRepository.findOne({
      where: { user_id: userId },
    });
    const isCook = cook && booking.cook_id === cook.id;
    const isUser = booking.user_id === userId;
    const isAdmin = userRole === 'admin';

    if (!isUser && !isCook && !isAdmin) {
      throw new ForbiddenException('Not authorized to update this booking');
    }

    // Validate status transitions
    this.validateStatusTransition(
      booking.status,
      dto.status,
      isUser,
      isCook,
      isAdmin,
    );

    // Update status
    booking.status = dto.status;

    // Set timestamps
    const now = new Date();
    switch (dto.status) {
      case BookingStatus.CONFIRMED:
        booking.confirmed_at = now;
        break;
      case BookingStatus.IN_PROGRESS:
        booking.started_at = now;
        break;
      case BookingStatus.COMPLETED:
        booking.completed_at = now;
        // Update cook stats
        if (cook) {
          cook.total_bookings += 1;
          await this.cooksRepository.save(cook);
        }
        break;
      case BookingStatus.CANCELLED_BY_USER:
      case BookingStatus.CANCELLED_BY_COOK:
        booking.cancelled_at = now;
        booking.cancellation_reason = dto.cancellation_reason || null;
        break;
    }

    await this.bookingsRepository.save(booking);

    return this.findById(bookingId);
  }

  // ─── STATUS TRANSITION VALIDATION ─────────────────────
  private validateStatusTransition(
    current: BookingStatus,
    next: BookingStatus,
    isUser: boolean,
    isCook: boolean,
    isAdmin: boolean,
  ) {
    const allowed: Record<BookingStatus, BookingStatus[]> = {
      [BookingStatus.PENDING]: [
        BookingStatus.CONFIRMED,
        BookingStatus.CANCELLED_BY_USER,
        BookingStatus.CANCELLED_BY_COOK,
        BookingStatus.EXPIRED,
      ],
      [BookingStatus.CONFIRMED]: [
        BookingStatus.IN_PROGRESS,
        BookingStatus.CANCELLED_BY_USER,
        BookingStatus.CANCELLED_BY_COOK,
      ],
      [BookingStatus.IN_PROGRESS]: [BookingStatus.COMPLETED],
      [BookingStatus.COMPLETED]: [],
      [BookingStatus.CANCELLED_BY_USER]: [],
      [BookingStatus.CANCELLED_BY_COOK]: [],
      [BookingStatus.EXPIRED]: [],
    };

    if (!allowed[current]?.includes(next)) {
      throw new BadRequestException(
        `Cannot transition from ${current} to ${next}`,
      );
    }

    // Role-based restrictions
    if (next === BookingStatus.CONFIRMED && !isCook && !isAdmin) {
      throw new ForbiddenException('Only the cook can confirm a booking');
    }

    if (next === BookingStatus.CANCELLED_BY_USER && !isUser && !isAdmin) {
      throw new ForbiddenException('Only the customer can cancel as user');
    }

    if (next === BookingStatus.CANCELLED_BY_COOK && !isCook && !isAdmin) {
      throw new ForbiddenException('Only the cook can cancel as cook');
    }

    if (next === BookingStatus.COMPLETED && !isUser && !isAdmin) {
      throw new ForbiddenException('Only the customer can mark as completed');
    }
  }

  // ─── CANCELLATION REFUND CALCULATION ──────────────────
  getCancellationRefund(booking: Booking): number {
    const hoursUntil =
      (new Date(booking.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60);

    if (hoursUntil > 24) return booking.total_price; // Full refund
    if (hoursUntil > 6) return booking.total_price * 0.5; // 50% refund
    return 0; // No refund
  }
}
