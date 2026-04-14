import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Booking, BookingStatus, BookingType } from './booking.entity';
import { Cook } from '../cooks/cook.entity';
import { User } from '../users/user.entity';
import { MenuItem } from '../cooks/menu-item.entity';
import {
  CreateBookingDto,
  UpdateBookingStatusDto,
  GetBookingsDto,
} from './dto/booking.dto';
import { NotificationsService } from '../notifications/notifications.service';

const PLATFORM_FEE_PERCENT = 0.15; // 15%

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

    // Prevent self-booking
    if (cook.user_id === userId) {
      throw new BadRequestException('You cannot book yourself');
    }

    // Check scheduled date is in the future
    const scheduledDate = new Date(dto.scheduled_at);
    if (scheduledDate <= new Date()) {
      throw new BadRequestException('Scheduled date must be in the future');
    }

    // Get customer info for notification
    const customer = await this.usersRepository.findOne({ where: { id: userId } });

    // ─── Calculate price based on selected menu items OR hourly rate ───
    let subtotal: number;
    let orderItemsForDb: Record<string, any>[] | null = null;
    let selectedDishNames: string[] = [];

    if (dto.selected_items && dto.selected_items.length > 0) {
      // Fetch actual menu items from DB to get real prices (prevent tampering)
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
      // Legacy: direct order_items from food delivery
      subtotal = dto.order_items.reduce(
        (sum, item) => sum + item.price * item.qty,
        0,
      );
      orderItemsForDb = dto.order_items;
    } else {
      // Hourly rate based
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
      dishes: selectedDishNames.length > 0
        ? selectedDishNames.join(', ')
        : (dto.dishes || null),
      instructions: dto.instructions,
      order_items: orderItemsForDb,
      subtotal,
      platform_fee: platformFee,
      total_price: totalPrice,
      status: BookingStatus.PENDING,
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

    // Set timestamps + send notifications
    const now = new Date();
    switch (dto.status) {
      case BookingStatus.CONFIRMED:
        booking.confirmed_at = now;
        // ─── NOTIFY: Chef accepted → customer ───
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
        // Notification handled by verifyStartOtp
        break;

      case BookingStatus.COMPLETED:
        booking.completed_at = now;
        // Calculate actual duration
        if (booking.started_at) {
          booking.actual_duration_minutes = Math.round(
            (now.getTime() - new Date(booking.started_at).getTime()) / (1000 * 60),
          );
        }
        // Update cook stats
        if (cook) {
          cook.total_bookings += 1;
          await this.cooksRepository.save(cook);
        }
        // ─── NOTIFY: Session completed → both ───
        this.notificationsService
          .notifySessionCompleted(
            booking.user_id,
            booking.cook?.user_id,
            bookingId,
            booking.actual_duration_minutes || 0,
          )
          .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));
        // ─── NOTIFY: Review prompt → customer ───
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
        // Calculate refund
        booking.refund_amount = this.getCancellationRefund(booking);
        // ─── NOTIFY: Customer cancelled → chef ───
        if (booking.cook?.user_id) {
          this.notificationsService
            .notifyBookingCancelled(booking.cook.user_id, bookingId, 'customer')
            .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));
        }
        break;

      case BookingStatus.CANCELLED_BY_COOK:
        booking.cancelled_at = now;
        booking.cancellation_reason = dto.cancellation_reason || null;
        // Chef cancels → full refund to customer
        booking.refund_amount = Number(booking.total_price);
        // ─── NOTIFY: Chef cancelled → customer ───
        this.notificationsService
          .notifyBookingCancelled(booking.user_id, bookingId, 'chef')
          .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));
        break;
    }

    await this.bookingsRepository.save(booking);

    return this.findById(bookingId);
  }

  // ═══════════════════════════════════════════════════════
  // COOKING SESSION OTP
  // ═══════════════════════════════════════════════════════

  /** Chef clicks "Start Cooking" → OTP sent to customer email */
  async sendStartOtp(bookingId: string, userId: string) {
    const booking = await this.findById(bookingId);

    // Only the assigned cook can send start OTP
    const cook = await this.cooksRepository.findOne({ where: { user_id: userId } });
    if (!cook || booking.cook_id !== cook.id) {
      throw new ForbiddenException('Only the assigned chef can start this session');
    }

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException('Booking must be confirmed before starting');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    booking.start_otp = otp;
    booking.start_otp_expires_at = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    await this.bookingsRepository.save(booking);

    // Send OTP to customer email
    const customerEmail = booking.user?.email;
    if (customerEmail) {
      this.sendCookingOtpEmail(customerEmail, otp, 'start', booking.cook?.user?.name || 'Your chef')
        .catch((err) => this.logger.warn(`Start OTP email failed: ${err.message}`));
    }

    return { message: 'Start OTP sent to customer', expires_in_minutes: 10 };
  }

  /** Chef enters start OTP → session starts */
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

    // OTP verified → start session
    booking.status = BookingStatus.IN_PROGRESS;
    booking.started_at = new Date();
    booking.start_otp = null;
    booking.start_otp_expires_at = null;
    await this.bookingsRepository.save(booking);

    // ─── NOTIFY: Cooking started → customer ───
    this.notificationsService
      .notifySessionStarted(
        booking.user_id,
        bookingId,
        booking.cook?.user?.name || 'Your chef',
      )
      .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));

    return { message: 'Cooking session started', started_at: booking.started_at };
  }

  /** Chef clicks "End Session" → OTP sent to customer email */
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

  /** Chef enters end OTP → session ends, duration calculated */
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

    // OTP verified → complete session
    const now = new Date();
    booking.status = BookingStatus.COMPLETED;
    booking.completed_at = now;
    booking.end_otp = null;
    booking.end_otp_expires_at = null;

    // Calculate actual duration
    if (booking.started_at) {
      booking.actual_duration_minutes = Math.round(
        (now.getTime() - new Date(booking.started_at).getTime()) / (1000 * 60),
      );
    }

    await this.bookingsRepository.save(booking);

    // Update cook stats
    cook.total_bookings += 1;
    await this.cooksRepository.save(cook);

    // ─── NOTIFY: Session completed → both ───
    this.notificationsService
      .notifySessionCompleted(
        booking.user_id,
        cook.user_id,
        bookingId,
        booking.actual_duration_minutes || 0,
      )
      .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));

    // ─── NOTIFY: Review prompt → customer ───
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

    if (next === BookingStatus.CONFIRMED && !isCook && !isAdmin) {
      throw new ForbiddenException('Only the cook can confirm a booking');
    }

    if (next === BookingStatus.CANCELLED_BY_USER && !isUser && !isAdmin) {
      throw new ForbiddenException('Only the customer can cancel as user');
    }

    if (next === BookingStatus.CANCELLED_BY_COOK && !isCook && !isAdmin) {
      throw new ForbiddenException('Only the cook can cancel as cook');
    }

    // Note: COMPLETED is now handled via verifyEndOtp primarily
    // But we keep the manual option for admin
    if (next === BookingStatus.COMPLETED && !isAdmin) {
      throw new ForbiddenException('Session completion requires end OTP verification');
    }
  }

  // ─── CANCELLATION REFUND CALCULATION ──────────────────
  // Policy: 4+ hours = full refund, 2-4 hours = 50%, <2 hours = no refund
  // Chef cancels = always full refund
  getCancellationRefund(booking: Booking): number {
    const hoursUntil =
      (new Date(booking.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60);

    if (hoursUntil >= 4) return Number(booking.total_price); // Full refund
    if (hoursUntil >= 2) return Number(booking.total_price) * 0.5; // 50% refund
    return 0; // No refund within 2 hours
  }

  // ─── SEND COOKING OTP EMAIL (via Brevo) ───────────────
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

    const heading = isStart
      ? 'Cooking Session Starting!'
      : 'Cooking Session Ending';

    const message = isStart
      ? `${chefName} is ready to start cooking! Share this OTP with your chef to begin the session.`
      : `${chefName} has finished cooking. Share this OTP with your chef to end the session.`;

    const html = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #FFF8F0; border-radius: 16px; padding: 40px 32px; border: 1px solid #FFE4B5;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="font-weight: 900; font-size: 24px; color: #2D1810;">COOK</span><span style="font-weight: 900; font-size: 24px; color: #D4721A;">ONCALL</span>
        </div>
        <h2 style="text-align: center; color: #2D1810; font-size: 20px; margin-bottom: 8px;">${heading}</h2>
        <p style="text-align: center; color: #8B7355; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
          ${message}
        </p>
        <div style="background: white; border-radius: 12px; padding: 20px; text-align: center; border: 2px dashed #FFB347; margin-bottom: 24px;">
          <div style="font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #D4721A;">${otp}</div>
          <div style="font-size: 12px; color: #8B7355; margin-top: 8px;">Valid for 10 minutes</div>
        </div>
        <p style="text-align: center; color: #B0A090; font-size: 12px;">
          Do not share this OTP with anyone other than your chef.
        </p>
        <hr style="border: none; border-top: 1px solid #FFE4B5; margin: 24px 0;" />
        <p style="text-align: center; color: #B0A090; font-size: 11px;">
          &copy; ${new Date().getFullYear()} CookOnCall &middot; Ahmedabad, India
        </p>
      </div>
    `;

    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.brevoApiKey,
        },
        body: JSON.stringify({
          sender: { name: 'CookOnCall', email: 'aryankhamar20@gmail.com' },
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

  // ─── SEND BOOKING RECEIPT EMAIL (via Brevo) ───────────
  private async sendBookingReceiptEmail(
    email: string,
    customerName: string,
    bookingId: string,
    chefName: string,
    scheduledAt: Date,
    address: string,
    dishes: string[],
    subtotal: number,
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
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeStr = scheduledAt.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
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

        <h2 style="text-align: center; color: #2D1810; font-size: 20px; margin-bottom: 8px;">Booking Confirmation</h2>
        <p style="text-align: center; color: #8B7355; font-size: 14px; margin-bottom: 24px;">
          Thank you, ${customerName}! Your booking has been placed.
        </p>

        <div style="background: white; border-radius: 12px; padding: 20px; border: 1px solid #FFE4B5; margin-bottom: 16px;">
          <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #8B7355; width: 40%;">Booking ID</td>
              <td style="padding: 8px 0; color: #2D1810; font-weight: 600;">#${shortId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #8B7355;">Chef</td>
              <td style="padding: 8px 0; color: #2D1810; font-weight: 600;">${chefName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #8B7355;">Date</td>
              <td style="padding: 8px 0; color: #2D1810;">${dateStr}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #8B7355;">Time</td>
              <td style="padding: 8px 0; color: #2D1810;">${timeStr}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #8B7355;">Duration</td>
              <td style="padding: 8px 0; color: #2D1810;">${durationHours} hours</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #8B7355;">Guests</td>
              <td style="padding: 8px 0; color: #2D1810;">${guests}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #8B7355; vertical-align: top;">Address</td>
              <td style="padding: 8px 0; color: #2D1810;">${address}</td>
            </tr>
          </table>
        </div>

        <div style="background: white; border-radius: 12px; padding: 20px; border: 1px solid #FFE4B5; margin-bottom: 16px;">
          <h3 style="color: #2D1810; font-size: 15px; margin: 0 0 12px;">Selected Dishes</h3>
          <ul style="margin: 0; padding-left: 20px; font-size: 14px;">
            ${dishListHtml}
          </ul>
        </div>

        <div style="background: white; border-radius: 12px; padding: 20px; border: 1px solid #FFE4B5; margin-bottom: 24px;">
          <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
            <tr>
              <td style="padding: 6px 0; color: #8B7355;">Subtotal</td>
              <td style="padding: 6px 0; color: #2D1810; text-align: right;">&#8377;${subtotal.toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #8B7355;">Platform Fee (15%)</td>
              <td style="padding: 6px 0; color: #2D1810; text-align: right;">&#8377;${platformFee.toFixed(2)}</td>
            </tr>
            <tr>
              <td colspan="2"><hr style="border: none; border-top: 1px dashed #FFE4B5; margin: 8px 0;" /></td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #2D1810; font-weight: 700; font-size: 16px;">Total</td>
              <td style="padding: 6px 0; color: #D4721A; font-weight: 700; font-size: 16px; text-align: right;">&#8377;${total.toFixed(2)}</td>
            </tr>
          </table>
        </div>

        <p style="text-align: center; color: #8B7355; font-size: 13px; line-height: 1.6; margin-bottom: 16px;">
          Your chef will be notified and will accept or decline your request shortly. You'll receive an email once confirmed.
        </p>

        <hr style="border: none; border-top: 1px solid #FFE4B5; margin: 24px 0;" />
        <p style="text-align: center; color: #B0A090; font-size: 11px;">
          &copy; ${new Date().getFullYear()} CookOnCall &middot; Ahmedabad, India
        </p>
      </div>
    `;

    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.brevoApiKey,
        },
        body: JSON.stringify({
          sender: { name: 'CookOnCall', email: 'aryankhamar20@gmail.com' },
          to: [{ email }],
          subject: `Booking Confirmed — #${shortId} | CookOnCall`,
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
