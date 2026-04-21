import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Booking, BookingStatus, BookingType } from './booking.entity';
import { Cook } from '../cooks/cook.entity';
import { User } from '../users/user.entity';
import { MenuItem } from '../cooks/menu-item.entity';
import {
  CreateBookingDto,
  UpdateBookingStatusDto,
  GetBookingsDto,
  RejectBookingDto,
  RebookDto,
} from './dto/booking.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { Payment, PaymentStatus } from '../payments/payment.entity';

// ─── Pricing model (Apr 19, 2026 launch) ────────────────────────────────
const VISIT_FEE_HOME_COOKING = 49;
const CONVENIENCE_RATE = 0.025;

// ─── NEW FLOW TIMING (Apr 21, 2026) ─────────────────────────────────────
// Both windows are 3 hours. On-demand check — no background job.
const CHEF_APPROVAL_WINDOW_MS = 3 * 60 * 60 * 1000;
const PAYMENT_WINDOW_MS = 3 * 60 * 60 * 1000;

// Statuses that are eligible for the on-demand expiry sweep.
const EXPIRABLE_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING_CHEF_APPROVAL,
  BookingStatus.AWAITING_PAYMENT,
  // Legacy rows created before Apr 21 migration — treated same as PENDING_CHEF_APPROVAL.
  BookingStatus.PENDING,
];

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  private brevoApiKey: string;

  constructor(
    @InjectRepository(Booking)
    private bookingsRepository: Repository<Booking>,
    @InjectRepository(Cook)
    private cooksRepository: Repository<Cook>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(MenuItem)
    private menuItemsRepository: Repository<MenuItem>,
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    private notificationsService: NotificationsService,
    private configService: ConfigService,
  ) {
    this.brevoApiKey = this.configService.get<string>('BREVO_API_KEY', '');
  }

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

    if (cook.user_id === userId) {
      throw new BadRequestException('You cannot book yourself');
    }

    const scheduledDate = new Date(dto.scheduled_at);
    if (scheduledDate <= new Date()) {
      throw new BadRequestException('Scheduled date must be in the future');
    }

    const customer = await this.usersRepository.findOne({ where: { id: userId } });

    // ─── Calculate subtotal from selected menu items ──────────────────────
    let subtotal: number;
    let orderItemsForDb: Record<string, any>[] | null = null;
    const selectedDishNames: string[] = [];

    if (dto.selected_items && dto.selected_items.length > 0) {
      const menuItems = await this.menuItemsRepository.findBy(
        dto.selected_items.map((si) => ({ id: si.menuItemId })),
      );

      const menuMap = new Map(menuItems.map((m) => [m.id, m]));

      orderItemsForDb = dto.selected_items.map((si) => {
        const item = menuMap.get(si.menuItemId);
        if (!item) {
          throw new BadRequestException(`Menu item ${si.menuItemId} not found`);
        }
        if (item.cook_id !== dto.cook_id) {
          throw new BadRequestException(`Menu item ${item.name} does not belong to this chef`);
        }
        selectedDishNames.push(item.name);
        return {
          menuItemId: item.id,
          name: item.name,
          qty: si.qty || 1,
          price: Number(item.price),
        };
      });

      subtotal = orderItemsForDb.reduce(
        (sum, item) => sum + item.price * item.qty,
        0,
      );
    } else if (dto.order_items?.length) {
      subtotal = dto.order_items.reduce(
        (sum, item) => sum + item.price * item.qty,
        0,
      );
      orderItemsForDb = dto.order_items;
    } else {
      throw new BadRequestException(
        "Please select at least one dish from the chef's menu before booking.",
      );
    }

    if (!subtotal || subtotal <= 0 || Number.isNaN(subtotal)) {
      throw new BadRequestException(
        'Booking subtotal must be greater than zero. Please select at least one dish.',
      );
    }

    const bookingType = dto.booking_type || BookingType.HOME_COOKING;
    const visitFee =
      bookingType === BookingType.HOME_COOKING ? VISIT_FEE_HOME_COOKING : 0;
    const convenienceFee = Math.round(subtotal * CONVENIENCE_RATE);
    const platformFee = convenienceFee;
    const totalPrice = subtotal + visitFee + convenienceFee;

    const booking = this.bookingsRepository.create({
      user_id: userId,
      cook_id: dto.cook_id,
      booking_type: bookingType,
      scheduled_at: scheduledDate,
      duration_hours: dto.duration_hours || 2,
      guests: dto.guests || 2,
      address: dto.address,
      latitude: dto.latitude,
      longitude: dto.longitude,
      dishes: selectedDishNames.length > 0
        ? selectedDishNames.join(', ')
        : (dto.dishes || null),
      instructions: dto.instructions,
      order_items: orderItemsForDb,
      subtotal,
      platform_fee: platformFee,
      total_price: totalPrice,
      // ─── NEW FLOW: customer books → chef must accept first ──
      status: BookingStatus.PENDING_CHEF_APPROVAL,
      visit_fee: visitFee,
      platform_fee_percent: 2.5,
    });

    const saved = await this.bookingsRepository.save(booking);

    // ─── NOTIFY: Booking created → chef + customer ───
    this.notificationsService
      .notifyBookingCreated(userId, cook.user_id, saved.id, customer?.name || 'A customer')
      .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));

    // ─── SEND BOOKING RECEIPT EMAIL → customer ───
    if (customer?.email) {
      this.sendBookingReceiptEmail(
        customer.email,
        customer.name || 'Customer',
        saved.id,
        cook.user?.name || 'Your Chef',
        scheduledDate,
        dto.address,
        selectedDishNames.length > 0 ? selectedDishNames : (dto.dishes ? dto.dishes.split(',').map(d => d.trim()) : []),
        subtotal,
        visitFee,
        platformFee,
        totalPrice,
        dto.duration_hours || 2,
        dto.guests || 2,
      ).catch((err) => this.logger.warn(`Receipt email failed: ${err.message}`));
    }

    return this.findById(saved.id);
  }

  // ─── GET USER BOOKINGS ────────────────────────────────
  async getUserBookings(userId: string, dto: GetBookingsDto) {
    // On-demand expiry pass BEFORE reading
    await this.sweepExpiryForUser(userId);

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

    // Strip rejection_reason from each — never leak it to the customer.
    const sanitized = bookings.map((b) => this.stripInternalFields(b));

    return {
      bookings: sanitized,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── GET COOK BOOKINGS (REQUESTS) ─────────────────────
  async getCookBookings(userId: string, dto: GetBookingsDto) {
    const cook = await this.cooksRepository.findOne({
      where: { user_id: userId },
    });

    if (!cook) {
      throw new NotFoundException('Cook profile not found');
    }

    // On-demand expiry pass BEFORE reading
    await this.sweepExpiryForCook(cook.id);

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

  /**
   * Same as findById but strips rejection_reason for customer-facing endpoints.
   * Use this when the requester is the customer (not admin, not chef).
   */
  async findByIdForCustomer(id: string) {
    const b = await this.findById(id);
    return this.stripInternalFields(b);
  }

  // ═══════════════════════════════════════════════════════
  // NEW FLOW: CHEF ACCEPT / REJECT
  // ═══════════════════════════════════════════════════════

  /**
   * Chef accepts a booking → status becomes AWAITING_PAYMENT.
   * Customer has 3 hours to pay.
   */
  async acceptBooking(bookingId: string, userId: string) {
    const booking = await this.findById(bookingId);

    const cook = await this.cooksRepository.findOne({ where: { user_id: userId } });
    if (!cook || booking.cook_id !== cook.id) {
      throw new ForbiddenException('Only the assigned chef can accept this booking');
    }

    // Run expiry check — chef might be accepting too late
    const maybeExpired = await this.expireIfLapsed(booking);
    if (maybeExpired.status === BookingStatus.EXPIRED) {
      throw new BadRequestException('This booking has expired and can no longer be accepted');
    }

    if (
      booking.status !== BookingStatus.PENDING_CHEF_APPROVAL &&
      booking.status !== BookingStatus.PENDING // legacy rows
    ) {
      throw new BadRequestException(
        `Cannot accept a booking in status "${booking.status}"`,
      );
    }

    const now = new Date();
    booking.status = BookingStatus.AWAITING_PAYMENT;
    booking.chef_responded_at = now;
    booking.payment_expires_at = new Date(now.getTime() + PAYMENT_WINDOW_MS);

    await this.bookingsRepository.save(booking);

    // ─── NOTIFY: Chef accepted → customer (in-app + email) ───
    this.notificationsService
      .notifyChefAccepted(
        booking.user_id,
        booking.user?.email || null,
        bookingId,
        booking.cook?.user?.name || 'Your chef',
      )
      .catch((err) => this.logger.warn(`Accept notification failed: ${err.message}`));

    return this.findById(bookingId);
  }

  /**
   * Chef rejects a booking with a reason.
   * Reason stays internal — customer is NEVER shown the reason.
   */
  async rejectBooking(bookingId: string, userId: string, dto: RejectBookingDto) {
    const booking = await this.findById(bookingId);

    const cook = await this.cooksRepository.findOne({ where: { user_id: userId } });
    if (!cook || booking.cook_id !== cook.id) {
      throw new ForbiddenException('Only the assigned chef can reject this booking');
    }

    if (
      booking.status !== BookingStatus.PENDING_CHEF_APPROVAL &&
      booking.status !== BookingStatus.PENDING // legacy rows
    ) {
      throw new BadRequestException(
        `Cannot reject a booking in status "${booking.status}"`,
      );
    }

    const now = new Date();
    booking.status = BookingStatus.CANCELLED_BY_COOK;
    booking.cancelled_at = now;
    booking.chef_responded_at = now;
    booking.rejection_reason = dto.reason; // internal only
    booking.cancellation_reason = null; // keep separate from customer-visible cancel reason

    await this.bookingsRepository.save(booking);

    // ─── NOTIFY: Chef rejected → customer (NO reason) ───
    this.notificationsService
      .notifyChefRejected(
        booking.user_id,
        booking.user?.email || null,
        bookingId,
        booking.cook?.user?.name || 'The chef',
      )
      .catch((err) => this.logger.warn(`Reject notification failed: ${err.message}`));

    // Return customer-safe view (no rejection_reason) — but the chef is calling
    // this endpoint. It is still safe to strip; chef didn't need it echoed back.
    return this.stripInternalFields(booking);
  }

  // ═══════════════════════════════════════════════════════
  // NEW FLOW: REBOOK WITH A DIFFERENT CHEF
  // ═══════════════════════════════════════════════════════

  /**
   * Customer picks "Book another chef" after rejection/expiry.
   * Creates a brand new booking with new cook_id + freshly selected dishes,
   * carrying over scheduled_at, guests, duration_hours, address.
   * Links the old booking to the new one via rebooked_to_id.
   */
  async rebookWithDifferentChef(
    originalBookingId: string,
    userId: string,
    dto: RebookDto,
  ) {
    const original = await this.findById(originalBookingId);

    if (original.user_id !== userId) {
      throw new ForbiddenException('Not authorized to rebook this booking');
    }

    const isEligible =
      original.status === BookingStatus.CANCELLED_BY_COOK ||
      original.status === BookingStatus.EXPIRED;
    if (!isEligible) {
      throw new BadRequestException(
        'Only rejected or expired bookings can be rebooked',
      );
    }

    if (original.rebooked_to_id) {
      throw new BadRequestException('This booking has already been rebooked');
    }

    if (dto.new_cook_id === original.cook_id) {
      throw new BadRequestException('Please choose a different chef');
    }

    // Create new booking using the customer-facing flow. Date/address/guests
    // carry over; dishes + chef are fresh.
    const created = await this.createBooking(userId, {
      cook_id: dto.new_cook_id,
      booking_type: original.booking_type,
      scheduled_at: original.scheduled_at.toISOString(),
      duration_hours: original.duration_hours,
      guests: original.guests,
      address: original.address,
      latitude: original.latitude ? Number(original.latitude) : undefined,
      longitude: original.longitude ? Number(original.longitude) : undefined,
      instructions: dto.instructions ?? original.instructions ?? undefined,
      selected_items: dto.selected_items,
    });

    // Link original → new for admin audit trail
    await this.bookingsRepository.update(originalBookingId, {
      rebooked_to_id: created.id,
    });

    return this.findByIdForCustomer(created.id);
  }

  // ═══════════════════════════════════════════════════════
  // ON-DEMAND EXPIRY (no background job)
  // ═══════════════════════════════════════════════════════

  /**
   * Expire a single booking if its window has lapsed.
   * Returns the booking (updated if expired, unchanged otherwise).
   */
  async expireIfLapsed(booking: Booking): Promise<Booking> {
    if (!EXPIRABLE_STATUSES.includes(booking.status)) return booking;

    const now = Date.now();

    // Chef approval window: 3h from created_at
    if (
      booking.status === BookingStatus.PENDING_CHEF_APPROVAL ||
      booking.status === BookingStatus.PENDING
    ) {
      const createdMs = new Date(booking.created_at).getTime();
      if (now - createdMs >= CHEF_APPROVAL_WINDOW_MS) {
        booking.status = BookingStatus.EXPIRED;
        booking.cancelled_at = new Date();
        await this.bookingsRepository.save(booking);
        // Notify both customer AND chef
        this.fireExpiryNotifications(booking).catch(() => undefined);
      }
      return booking;
    }

    // Payment window: 3h from chef_responded_at (or fall back to payment_expires_at)
    if (booking.status === BookingStatus.AWAITING_PAYMENT) {
      const deadlineMs = booking.payment_expires_at
        ? new Date(booking.payment_expires_at).getTime()
        : (booking.chef_responded_at
          ? new Date(booking.chef_responded_at).getTime() + PAYMENT_WINDOW_MS
          : new Date(booking.created_at).getTime() + PAYMENT_WINDOW_MS);
      if (now >= deadlineMs) {
        booking.status = BookingStatus.EXPIRED;
        booking.cancelled_at = new Date();
        await this.bookingsRepository.save(booking);
        this.fireExpiryNotifications(booking).catch(() => undefined);
      }
    }

    return booking;
  }

  /** Sweep all customer-owned bookings for expiry before returning a list */
  private async sweepExpiryForUser(userId: string): Promise<void> {
    const candidates = await this.bookingsRepository.find({
      where: { user_id: userId, status: In(EXPIRABLE_STATUSES) },
      relations: ['user', 'cook', 'cook.user'],
    });
    for (const b of candidates) {
      try { await this.expireIfLapsed(b); } catch (err) {
        this.logger.warn(`Expiry sweep failed for ${b.id}: ${err?.message}`);
      }
    }
  }

  /** Sweep all cook-owned bookings for expiry before returning a list */
  private async sweepExpiryForCook(cookId: string): Promise<void> {
    const candidates = await this.bookingsRepository.find({
      where: { cook_id: cookId, status: In(EXPIRABLE_STATUSES) },
      relations: ['user', 'cook', 'cook.user'],
    });
    for (const b of candidates) {
      try { await this.expireIfLapsed(b); } catch (err) {
        this.logger.warn(`Expiry sweep failed for ${b.id}: ${err?.message}`);
      }
    }
  }

  private async fireExpiryNotifications(booking: Booking) {
    // Customer always notified
    await this.notificationsService.notifyBookingExpired(
      booking.user_id,
      booking.user?.email || null,
      booking.id,
      'customer',
    );
    // Chef notified
    if (booking.cook?.user_id) {
      await this.notificationsService.notifyBookingExpired(
        booking.cook.user_id,
        booking.cook.user?.email || null,
        booking.id,
        'chef',
      );
    }
  }

  /** Remove internal-only fields before returning to customer endpoints */
  private stripInternalFields(b: Booking): Booking {
    // Return a shallow copy with sensitive field nulled.
    const safe: any = { ...b };
    safe.rejection_reason = null;
    return safe as Booking;
  }

  // ─── UPDATE BOOKING STATUS ────────────────────────────
  // Kept for backward-compat (cancel flows, admin overrides, etc.)
  async updateStatus(
    bookingId: string,
    userId: string,
    userRole: string,
    dto: UpdateBookingStatusDto,
  ) {
    const booking = await this.findById(bookingId);

    const cook = await this.cooksRepository.findOne({
      where: { user_id: userId },
    });
    const isCook = cook && booking.cook_id === cook.id;
    const isUser = booking.user_id === userId;
    const isAdmin = userRole === 'admin';

    if (!isUser && !isCook && !isAdmin) {
      throw new ForbiddenException('Not authorized to update this booking');
    }

    this.validateStatusTransition(
      booking.status,
      dto.status,
      isUser,
      isCook,
      isAdmin,
    );

    // NEW FLOW: chef is no longer allowed to transition to CONFIRMED here.
    // Chef uses /accept which goes to AWAITING_PAYMENT.
    // Payment capture is what moves AWAITING_PAYMENT → CONFIRMED.
    if (dto.status === BookingStatus.CONFIRMED && !isAdmin) {
      throw new ForbiddenException(
        'Booking can only be confirmed by payment capture. Chef must use /accept.',
      );
    }

    // Admin override path: if admin forces CONFIRMED, still require a captured payment.
    if (dto.status === BookingStatus.CONFIRMED && isAdmin) {
      const payment = await this.paymentsRepository.findOne({
        where: { booking_id: bookingId, status: PaymentStatus.CAPTURED },
      });
      if (!payment) {
        throw new BadRequestException('Payment must be captured before confirming booking');
      }
    }

    booking.status = dto.status;

    const now = new Date();
    switch (dto.status) {
      case BookingStatus.CONFIRMED:
        booking.confirmed_at = now;
        this.notificationsService
          .notifyBookingConfirmed(
            booking.user_id,
            bookingId,
            booking.cook?.user?.name || 'Your chef',
          )
          .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));
        break;

      case BookingStatus.IN_PROGRESS:
        booking.started_at = now;
        break;

      case BookingStatus.COMPLETED:
        booking.completed_at = now;
        if (booking.started_at) {
          booking.actual_duration_minutes = Math.round(
            (now.getTime() - new Date(booking.started_at).getTime()) / (1000 * 60),
          );
        }
        if (cook) {
          cook.total_bookings += 1;
          await this.cooksRepository.save(cook);
        }
        this.notificationsService
          .notifySessionCompleted(
            booking.user_id,
            booking.cook?.user_id,
            bookingId,
            booking.actual_duration_minutes || 0,
          )
          .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));
        this.notificationsService
          .notifyReviewPrompt(
            booking.user_id,
            bookingId,
            booking.cook?.user?.name || 'your chef',
          )
          .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));
        break;

      case BookingStatus.CANCELLED_BY_USER:
        booking.cancelled_at = now;
        booking.cancellation_reason = dto.cancellation_reason || null;
        booking.refund_amount = this.getCancellationRefund(booking);
        if (booking.cook?.user_id) {
          this.notificationsService
            .notifyBookingCancelled(booking.cook.user_id, bookingId, 'customer')
            .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));
        }
        break;

      case BookingStatus.CANCELLED_BY_COOK:
        booking.cancelled_at = now;
        booking.cancellation_reason = dto.cancellation_reason || null;
        booking.refund_amount = Number(booking.total_price);
        this.notificationsService
          .notifyBookingCancelled(booking.user_id, bookingId, 'chef')
          .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));
        break;
    }

    await this.bookingsRepository.save(booking);

    return this.findById(bookingId);
  }

  // ═══════════════════════════════════════════════════════
  // COOKING SESSION OTP (unchanged)
  // ═══════════════════════════════════════════════════════

  async sendStartOtp(bookingId: string, userId: string) {
    const booking = await this.findById(bookingId);

    const cook = await this.cooksRepository.findOne({ where: { user_id: userId } });
    if (!cook || booking.cook_id !== cook.id) {
      throw new ForbiddenException('Only the assigned chef can start this session');
    }

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException('Booking must be confirmed before starting');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    booking.start_otp = otp;
    booking.start_otp_expires_at = new Date(Date.now() + 10 * 60 * 1000);
    await this.bookingsRepository.save(booking);

    const customerEmail = booking.user?.email;
    if (customerEmail) {
      this.sendCookingOtpEmail(customerEmail, otp, 'start', booking.cook?.user?.name || 'Your chef')
        .catch((err) => this.logger.warn(`Start OTP email failed: ${err.message}`));
    }

    return { message: 'Start OTP sent to customer', expires_in_minutes: 10 };
  }

  async verifyStartOtp(bookingId: string, userId: string, otp: string) {
    const booking = await this.findById(bookingId);

    const cook = await this.cooksRepository.findOne({ where: { user_id: userId } });
    if (!cook || booking.cook_id !== cook.id) {
      throw new ForbiddenException('Only the assigned chef can verify this OTP');
    }

    if (!booking.start_otp || !booking.start_otp_expires_at) {
      throw new BadRequestException('No start OTP requested');
    }

    if (new Date() > booking.start_otp_expires_at) {
      throw new BadRequestException('Start OTP expired. Please request a new one.');
    }

    if (booking.start_otp !== otp) {
      throw new BadRequestException('Invalid OTP');
    }

    booking.status = BookingStatus.IN_PROGRESS;
    booking.started_at = new Date();
    booking.start_otp = null;
    booking.start_otp_expires_at = null;
    await this.bookingsRepository.save(booking);

    this.notificationsService
      .notifySessionStarted(
        booking.user_id,
        bookingId,
        booking.cook?.user?.name || 'Your chef',
      )
      .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));

    return { message: 'Cooking session started', started_at: booking.started_at };
  }

  async sendEndOtp(bookingId: string, userId: string) {
    const booking = await this.findById(bookingId);

    const cook = await this.cooksRepository.findOne({ where: { user_id: userId } });
    if (!cook || booking.cook_id !== cook.id) {
      throw new ForbiddenException('Only the assigned chef can end this session');
    }

    if (booking.status !== BookingStatus.IN_PROGRESS) {
      throw new BadRequestException('Session must be in progress to end it');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    booking.end_otp = otp;
    booking.end_otp_expires_at = new Date(Date.now() + 10 * 60 * 1000);
    await this.bookingsRepository.save(booking);

    const customerEmail = booking.user?.email;
    if (customerEmail) {
      this.sendCookingOtpEmail(customerEmail, otp, 'end', booking.cook?.user?.name || 'Your chef')
        .catch((err) => this.logger.warn(`End OTP email failed: ${err.message}`));
    }

    return { message: 'End OTP sent to customer', expires_in_minutes: 10 };
  }

  async verifyEndOtp(bookingId: string, userId: string, otp: string) {
    const booking = await this.findById(bookingId);

    const cook = await this.cooksRepository.findOne({ where: { user_id: userId } });
    if (!cook || booking.cook_id !== cook.id) {
      throw new ForbiddenException('Only the assigned chef can verify this OTP');
    }

    if (!booking.end_otp || !booking.end_otp_expires_at) {
      throw new BadRequestException('No end OTP requested');
    }

    if (new Date() > booking.end_otp_expires_at) {
      throw new BadRequestException('End OTP expired. Please request a new one.');
    }

    if (booking.end_otp !== otp) {
      throw new BadRequestException('Invalid OTP');
    }

    const now = new Date();
    booking.status = BookingStatus.COMPLETED;
    booking.completed_at = now;
    booking.end_otp = null;
    booking.end_otp_expires_at = null;

    if (booking.started_at) {
      booking.actual_duration_minutes = Math.round(
        (now.getTime() - new Date(booking.started_at).getTime()) / (1000 * 60),
      );
    }

    await this.bookingsRepository.save(booking);

    cook.total_bookings += 1;
    await this.cooksRepository.save(cook);

    this.notificationsService
      .notifySessionCompleted(
        booking.user_id,
        cook.user_id,
        bookingId,
        booking.actual_duration_minutes || 0,
      )
      .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));

    this.notificationsService
      .notifyReviewPrompt(
        booking.user_id,
        bookingId,
        booking.cook?.user?.name || 'your chef',
      )
      .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));

    return {
      message: 'Cooking session completed',
      completed_at: booking.completed_at,
      actual_duration_minutes: booking.actual_duration_minutes,
    };
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
      [BookingStatus.PENDING_CHEF_APPROVAL]: [
        BookingStatus.AWAITING_PAYMENT,
        BookingStatus.CANCELLED_BY_USER,
        BookingStatus.CANCELLED_BY_COOK,
        BookingStatus.EXPIRED,
      ],
      [BookingStatus.AWAITING_PAYMENT]: [
        BookingStatus.CONFIRMED,
        BookingStatus.CANCELLED_BY_USER,
        BookingStatus.CANCELLED_BY_COOK,
        BookingStatus.EXPIRED,
      ],
      // Legacy: still accepted so old pending rows can be moved forward
      [BookingStatus.PENDING]: [
        BookingStatus.AWAITING_PAYMENT,
        BookingStatus.CONFIRMED, // admin-only path
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

    if (next === BookingStatus.CANCELLED_BY_USER && !isUser && !isAdmin) {
      throw new ForbiddenException('Only the customer can cancel as user');
    }

    if (next === BookingStatus.CANCELLED_BY_COOK && !isCook && !isAdmin) {
      throw new ForbiddenException('Only the cook can cancel as cook');
    }

    if (next === BookingStatus.COMPLETED && !isAdmin) {
      throw new ForbiddenException('Session completion requires end OTP verification');
    }
  }

  // ─── CANCELLATION REFUND CALCULATION (Apr 19 launch policy) ──────────
  getCancellationRefund(booking: Booking): number {
    const hoursUntil =
      (new Date(booking.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60);

    const total = Number(booking.total_price);
    const visitFee = Number(booking.visit_fee || 0);
    const dishAmount = Math.max(total - visitFee, 0);

    if (hoursUntil >= 2) {
      return Math.round(dishAmount * 0.8 * 100) / 100;
    }
    return 0;
  }

  // ─── SEND COOKING OTP EMAIL (via Brevo) — unchanged ───
  private async sendCookingOtpEmail(
    email: string,
    otp: string,
    type: 'start' | 'end',
    chefName: string,
  ) {
    if (!this.brevoApiKey) {
      this.logger.warn(`BREVO_API_KEY not configured — cooking OTP for ${email}: ${otp}`);
      return;
    }

    const isStart = type === 'start';
    const subject = isStart
      ? 'Your Cooking Session OTP - Start'
      : 'Your Cooking Session OTP - End';

    const heading = isStart ? 'Cooking Session Starting!' : 'Cooking Session Ending';
    const message = isStart
      ? `${chefName} is ready to start cooking! Share this OTP with your chef to begin the session.`
      : `${chefName} has finished cooking. Share this OTP with your chef to end the session.`;

    const html = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #FFF8F0; border-radius: 16px; padding: 40px 32px; border: 1px solid #FFE4B5;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-weight: 900; font-size: 24px; color: #2D1810;">COOK</span><span style="font-weight: 900; font-size: 24px; color: #D4721A;">ONCALL</span>
        </div>
        <h2 style="text-align: center; color: #2D1810; font-size: 20px; margin-bottom: 8px;">${heading}</h2>
        <p style="text-align: center; color: #8B7355; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">${message}</p>
        <div style="background: white; border-radius: 12px; padding: 20px; text-align: center; border: 2px dashed #FFB347; margin-bottom: 24px;">
          <div style="font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #D4721A;">${otp}</div>
          <div style="font-size: 12px; color: #8B7355; margin-top: 8px;">Valid for 10 minutes</div>
        </div>
        <p style="text-align: center; color: #B0A090; font-size: 12px;">Do not share this OTP with anyone other than your chef.</p>
        <hr style="border: none; border-top: 1px solid #FFE4B5; margin: 24px 0;" />
        <p style="text-align: center; color: #B0A090; font-size: 11px;">&copy; ${new Date().getFullYear()} CookOnCall &middot; Ahmedabad, Gujarat, India</p>
      </div>
    `;

    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': this.brevoApiKey },
        body: JSON.stringify({
          sender: { name: 'CookOnCall', email: 'support@thecookoncall.com' },
          to: [{ email }],
          subject,
          htmlContent: html,
        }),
      });
      const result = await response.json();
      if (response.ok) {
        this.logger.log(`Cooking OTP (${type}) sent to ${email} — messageId: ${result.messageId}`);
      } else {
        this.logger.error(`Brevo error for cooking OTP: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      this.logger.error(`Failed to send cooking OTP to ${email}`, error);
    }
  }

  // ─── SEND BOOKING RECEIPT EMAIL (via Brevo) — unchanged except copy ──
  private async sendBookingReceiptEmail(
    email: string,
    customerName: string,
    bookingId: string,
    chefName: string,
    scheduledAt: Date,
    address: string,
    dishes: string[],
    subtotal: number,
    visitFee: number,
    platformFee: number,
    total: number,
    durationHours: number,
    guests: number,
  ) {
    if (!this.brevoApiKey) {
      this.logger.warn(`BREVO_API_KEY not configured — skipping receipt email for ${email}`);
      return;
    }

    const dateStr = scheduledAt.toLocaleDateString('en-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const timeStr = scheduledAt.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit',
    });

    const dishListHtml = dishes.length > 0
      ? dishes.map((d) => `<li style="padding: 4px 0; color: #5D4E37;">${d}</li>`).join('')
      : '<li style="padding: 4px 0; color: #8B7355;">As discussed with chef</li>';

    const shortId = bookingId.slice(0, 8).toUpperCase();

    const html = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #FFF8F0; border-radius: 16px; padding: 40px 32px; border: 1px solid #FFE4B5;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-weight: 900; font-size: 24px; color: #2D1810;">COOK</span><span style="font-weight: 900; font-size: 24px; color: #D4721A;">ONCALL</span>
        </div>
        <h2 style="text-align: center; color: #2D1810; font-size: 20px; margin-bottom: 8px;">Booking Request Received</h2>
        <p style="text-align: center; color: #8B7355; font-size: 14px; margin-bottom: 24px;">
          Thank you, ${customerName}! Your request has been sent to the chef.
        </p>
        <div style="background: white; border-radius: 12px; padding: 20px; border: 1px solid #FFE4B5; margin-bottom: 16px;">
          <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
            <tr><td style="padding: 8px 0; color: #8B7355; width: 40%;">Booking ID</td><td style="padding: 8px 0; color: #2D1810; font-weight: 600;">#${shortId}</td></tr>
            <tr><td style="padding: 8px 0; color: #8B7355;">Chef</td><td style="padding: 8px 0; color: #2D1810; font-weight: 600;">${chefName}</td></tr>
            <tr><td style="padding: 8px 0; color: #8B7355;">Date</td><td style="padding: 8px 0; color: #2D1810;">${dateStr}</td></tr>
            <tr><td style="padding: 8px 0; color: #8B7355;">Time</td><td style="padding: 8px 0; color: #2D1810;">${timeStr}</td></tr>
            <tr><td style="padding: 8px 0; color: #8B7355;">Duration</td><td style="padding: 8px 0; color: #2D1810;">${durationHours} hours</td></tr>
            <tr><td style="padding: 8px 0; color: #8B7355;">Guests</td><td style="padding: 8px 0; color: #2D1810;">${guests}</td></tr>
            <tr><td style="padding: 8px 0; color: #8B7355; vertical-align: top;">Address</td><td style="padding: 8px 0; color: #2D1810;">${address}</td></tr>
          </table>
        </div>
        <div style="background: white; border-radius: 12px; padding: 20px; border: 1px solid #FFE4B5; margin-bottom: 16px;">
          <h3 style="color: #2D1810; font-size: 15px; margin: 0 0 12px;">Selected Dishes</h3>
          <ul style="margin: 0; padding-left: 20px; font-size: 14px;">${dishListHtml}</ul>
        </div>
        <div style="background: white; border-radius: 12px; padding: 20px; border: 1px solid #FFE4B5; margin-bottom: 24px;">
          <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
            <tr><td style="padding: 6px 0; color: #8B7355;">Subtotal</td><td style="padding: 6px 0; color: #2D1810; text-align: right;">&#8377;${subtotal.toFixed(2)}</td></tr>
            ${visitFee > 0 ? `<tr><td style="padding: 6px 0; color: #8B7355;">Visit fee</td><td style="padding: 6px 0; color: #2D1810; text-align: right;">&#8377;${visitFee.toFixed(2)}</td></tr>` : ''}
            <tr><td style="padding: 6px 0; color: #8B7355;">Convenience fee (2.5%)</td><td style="padding: 6px 0; color: #2D1810; text-align: right;">&#8377;${platformFee.toFixed(2)}</td></tr>
            <tr><td colspan="2"><hr style="border: none; border-top: 1px dashed #FFE4B5; margin: 8px 0;" /></td></tr>
            <tr><td style="padding: 6px 0; color: #2D1810; font-weight: 700; font-size: 16px;">Total</td><td style="padding: 6px 0; color: #D4721A; font-weight: 700; font-size: 16px; text-align: right;">&#8377;${total.toFixed(2)}</td></tr>
            <tr><td colspan="2" style="padding: 6px 0; color: #8B7355; font-size: 11px; font-style: italic;">+ Ingredients at actual market cost (with receipt)</td></tr>
          </table>
        </div>
        <p style="text-align: center; color: #8B7355; font-size: 13px; line-height: 1.6; margin-bottom: 16px;">
          Your chef has 3 hours to accept or decline. Payment will only be requested after the chef accepts.
        </p>
        <hr style="border: none; border-top: 1px solid #FFE4B5; margin: 24px 0;" />
        <p style="text-align: center; color: #B0A090; font-size: 11px;">&copy; ${new Date().getFullYear()} CookOnCall &middot; Ahmedabad, Gujarat, India</p>
      </div>
    `;

    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': this.brevoApiKey },
        body: JSON.stringify({
          sender: { name: 'CookOnCall', email: 'support@thecookoncall.com' },
          to: [{ email }],
          subject: `Booking Request — #${shortId} | CookOnCall`,
          htmlContent: html,
        }),
      });
      const result = await response.json();
      if (response.ok) {
        this.logger.log(`Booking receipt sent to ${email} — bookingId: ${bookingId}`);
      } else {
        this.logger.error(`Brevo error for receipt: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      this.logger.error(`Failed to send booking receipt to ${email}`, error);
    }
  }
}
