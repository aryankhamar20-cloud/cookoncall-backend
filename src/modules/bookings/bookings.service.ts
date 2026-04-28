import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, Between, LessThan } from 'typeorm';
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
import { AvailabilityService } from '../availability/availability.service';

// ⚠️  VERIFY these import paths match your actual P1.5a entity files.
// If all 4 entities are in a single file, adjust accordingly.
import { MealPackage } from '../meal-packages/meal-package.entity';
import { PackageAddon } from '../meal-packages/package-addon.entity';

// ─── Pricing model (Apr 19, 2026 launch) ────────────────────────────────
const VISIT_FEE_HOME_COOKING = 49;
const CONVENIENCE_RATE = 0.025; // 2.5% convenience fee charged to customer

// ─── P1.6 — Per-area visit fee tiers (Apr 27, 2026) ─────────────────────
const VISIT_FEE_DEFAULT = 49;
const VISIT_FEE_EXTENDED = 79;
const ALLOWED_VISIT_FEES = new Set([VISIT_FEE_DEFAULT, VISIT_FEE_EXTENDED]);

/**
 * Resolve the visit fee for a booking based on chef + customer area.
 * Returns { fee, serves_area }. serves_area=false signals a soft-warning
 * case (chef hasn't listed customer's area) — booking is still allowed.
 *
 * Falls back to ₹49 if customer area is unknown (legacy addresses, or
 * customer typed area as 'Other').
 */
function resolveVisitFee(
  cook: { service_area_slugs: string[]; serves_all_city: boolean; service_area_fees: Record<string, number> | null },
  customerAreaSlug: string | null | undefined,
): { fee: number; serves_area: boolean } {
  if (cook.serves_all_city) {
    if (customerAreaSlug && cook.service_area_fees?.[customerAreaSlug] != null) {
      const overridden = Number(cook.service_area_fees[customerAreaSlug]);
      if (ALLOWED_VISIT_FEES.has(overridden)) {
        return { fee: overridden, serves_area: true };
      }
    }
    return { fee: VISIT_FEE_DEFAULT, serves_area: true };
  }
  if (!customerAreaSlug) {
    return { fee: VISIT_FEE_DEFAULT, serves_area: false };
  }
  const slugs = cook.service_area_slugs ?? [];
  const servesArea = slugs.includes(customerAreaSlug);
  if (!servesArea) return { fee: VISIT_FEE_DEFAULT, serves_area: false };
  const overridden = cook.service_area_fees?.[customerAreaSlug];
  if (overridden != null) {
    const n = Number(overridden);
    if (ALLOWED_VISIT_FEES.has(n)) return { fee: n, serves_area: true };
  }
  return { fee: VISIT_FEE_DEFAULT, serves_area: true };
}

// ─── NEW FLOW TIMING (Apr 21, 2026) ─────────────────────────────────────
const CHEF_APPROVAL_WINDOW_MS = 3 * 60 * 60 * 1000;
const PAYMENT_WINDOW_MS = 3 * 60 * 60 * 1000;

const EXPIRABLE_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING_CHEF_APPROVAL,
  BookingStatus.AWAITING_PAYMENT,
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
    // ─── P1.5c: Package repositories ─────────────────────
    @InjectRepository(MealPackage)
    private mealPackagesRepository: Repository<MealPackage>,
    @InjectRepository(PackageAddon)
    private packageAddonsRepository: Repository<PackageAddon>,
    private notificationsService: NotificationsService,
    private configService: ConfigService,
    private availabilityService: AvailabilityService,
  ) {
    this.brevoApiKey = this.configService.get<string>('BREVO_API_KEY', '');
  }

  // ─── PACKAGE PRICE CALCULATION (P1.5c) ───────────────
  private calculatePackageSubtotal(
    pkg: MealPackage,
    guestCount: number,
    selectedAddons: PackageAddon[],
  ): number {
    let basePrice: number;

    if (guestCount <= 2) basePrice = Number(pkg.price_2);
    else if (guestCount === 3) basePrice = Number(pkg.price_3);
    else if (guestCount === 4) basePrice = Number(pkg.price_4);
    else if (guestCount === 5) basePrice = Number(pkg.price_5);
    else {
      // Custom tier: price_5 + extra_person_charge per person beyond 5
      basePrice =
        Number(pkg.price_5) +
        (guestCount - 5) * Number(pkg.extra_person_charge || 59);
    }

    const addonTotal = selectedAddons.reduce(
      (sum, a) => sum + Number(a.price),
      0,
    );

    return basePrice + addonTotal;
  }

  // ─── CREATE BOOKING ───────────────────────────────────
  async createBooking(userId: string, dto: CreateBookingDto) {
    const cook = await this.cooksRepository.findOne({
      where: { id: dto.cook_id },
      relations: ['user'],
    });

    if (!cook) throw new NotFoundException('Cook not found');
    if (!cook.is_verified) throw new BadRequestException('Cook is not yet verified');
    if (!cook.is_available) throw new BadRequestException('Cook is currently unavailable');
    if (cook.user_id === userId) throw new BadRequestException('You cannot book yourself');

    const scheduledDate = new Date(dto.scheduled_at);
    if (scheduledDate <= new Date()) {
      throw new BadRequestException('Scheduled date must be in the future');
    }

    await this.availabilityService.assertSlotAvailable(
      dto.cook_id,
      scheduledDate,
      dto.duration_hours || 2,
    );

    const customer = await this.usersRepository.findOne({ where: { id: userId } });

    // ═══════════════════════════════════════════════════
    // BRANCH A — PACKAGE BOOKING (P1.5c)
    // ═══════════════════════════════════════════════════
    if (dto.packageId) {
      return this.createPackageBooking(userId, dto, cook, customer, scheduledDate);
    }

    // ═══════════════════════════════════════════════════
    // BRANCH B — BUILD YOUR OWN (existing menu flow)
    // ═══════════════════════════════════════════════════
    return this.createMenuBooking(userId, dto, cook, customer, scheduledDate);
  }

  // ─── PACKAGE BOOKING (P1.5c) ─────────────────────────
  private async createPackageBooking(
    userId: string,
    dto: CreateBookingDto,
    cook: Cook,
    customer: User | null,
    scheduledDate: Date,
  ) {
    // Fetch package with full relations
    const pkg = await this.mealPackagesRepository.findOne({
      where: { id: dto.packageId, cook_id: dto.cook_id, is_active: true },
      relations: ['categories', 'categories.dishes', 'addons'],
    });

    if (!pkg) {
      throw new NotFoundException('Meal package not found or is no longer active');
    }

    // Guest count for tier pricing
    const guestCount = dto.guestCount ?? dto.guests ?? 2;
    if (guestCount < 2) {
      throw new BadRequestException('Minimum 2 guests required for a package booking');
    }

    // Validate category selections against min/max rules
    if (dto.selectedCategories?.length) {
      for (const sel of dto.selectedCategories) {
        const cat = pkg.categories?.find((c) => c.id === sel.categoryId);
        if (!cat) {
          throw new BadRequestException(
            `Category ${sel.categoryId} does not belong to this package`,
          );
        }
        const minSel = cat.min_selections ?? 1;
        const maxSel = cat.max_selections ?? 1;
        if (sel.dishIds.length < minSel) {
          throw new BadRequestException(
            `"${cat.name}" requires at least ${minSel} dish selection(s)`,
          );
        }
        if (sel.dishIds.length > maxSel) {
          throw new BadRequestException(
            `"${cat.name}" allows at most ${maxSel} dish selection(s)`,
          );
        }
      }
    }

    // Resolve selected addons
    const selectedAddonIds = dto.selectedAddonIds ?? [];
    const activeAddons = (pkg.addons ?? []).filter(
      (a) => selectedAddonIds.includes(a.id) && a.is_available,
    );

    // Calculate price
    const pkgSubtotal = this.calculatePackageSubtotal(pkg, guestCount, activeAddons);

    // P1.6 — per-area visit fee for package bookings
    const customerArea = dto.customer_area_slug?.trim() || null;
    const { fee: resolvedVisit, serves_area: chefServesArea } = resolveVisitFee(
      cook,
      customerArea,
    );
    const visitFee = resolvedVisit;
    const convFee = Math.round(pkgSubtotal * CONVENIENCE_RATE);
    const totalPrice = pkgSubtotal + visitFee + convFee;

    if (!chefServesArea && customerArea) {
      this.logger.warn(
        `[area-mismatch] Package booking by user ${userId} for cook ${dto.cook_id} ` +
          `in area '${customerArea}' — chef does not list this area. Soft-allowed.`,
      );
    }

    // Build human-readable dish list (for email + booking record)
    const dishNames: string[] = [];
    for (const cat of pkg.categories ?? []) {
      const sel = dto.selectedCategories?.find((s) => s.categoryId === cat.id);
      if (!sel) continue;
      for (const dish of cat.dishes ?? []) {
        if (sel.dishIds.includes(dish.id)) dishNames.push(dish.name);
      }
    }
    for (const addon of activeAddons) dishNames.push(addon.name);

    // Build JSONB payloads for the booking record
    const selectedCategoriesData = (dto.selectedCategories ?? []).map((sel) => {
      const cat = pkg.categories?.find((c) => c.id === sel.categoryId);
      return {
        categoryId: cat?.id,
        categoryName: cat?.name,
        selectedDishes: (cat?.dishes ?? [])
          .filter((d) => sel.dishIds.includes(d.id))
          .map((d) => ({ id: d.id, name: d.name, type: d.type })),
      };
    });

    const selectedAddonsData = activeAddons.map((a) => ({
      addonId: a.id,
      name: a.name,
      price: Number(a.price),
    }));

    const booking = this.bookingsRepository.create({
      user_id: userId,
      cook_id: dto.cook_id,
      booking_type: BookingType.HOME_COOKING,
      scheduled_at: scheduledDate,
      duration_hours: dto.duration_hours ?? 3,
      guests: guestCount,
      address: dto.address,
      latitude: dto.latitude,
      longitude: dto.longitude,
      customer_area_slug: customerArea,
      dishes: dishNames.join(', '),
      instructions: dto.instructions,
      order_items: null,
      subtotal: pkgSubtotal,
      platform_fee: convFee,
      total_price: totalPrice,
      status: BookingStatus.PENDING_CHEF_APPROVAL,
      visit_fee: visitFee,
      platform_fee_percent: 2.5,
      // ─── Package fields ───────────────────────────────
      package_id: dto.packageId,
      is_package_booking: true,
      selected_categories: selectedCategoriesData,
      selected_addons: selectedAddonsData,
      ingredient_reminder_sent: false,
    });

    const saved = await this.bookingsRepository.save(booking);

    this.notificationsService
      .notifyBookingCreated(
        userId,
        cook.user_id,
        saved.id,
        customer?.name || 'A customer',
      )
      .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));

    if (customer?.email) {
      this.sendBookingReceiptEmail(
        customer.email,
        customer.name || 'Customer',
        saved.id,
        cook.user?.name || 'Your Chef',
        scheduledDate,
        dto.address,
        dishNames,
        pkgSubtotal,
        visitFee,
        convFee,
        totalPrice,
        booking.duration_hours,
        guestCount,
        pkg.name,
      ).catch((err) => this.logger.warn(`Receipt email failed: ${err.message}`));
    }

    return this.findById(saved.id);
  }

  // ─── BUILD YOUR OWN MENU BOOKING (existing logic) ────
  private async createMenuBooking(
    userId: string,
    dto: CreateBookingDto,
    cook: Cook,
    customer: User | null,
    scheduledDate: Date,
  ) {
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
        if (!item) throw new BadRequestException(`Menu item ${si.menuItemId} not found`);
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

    // P1.6 — per-area visit fee (₹49 default / ₹79 chef-extended)
    const customerArea = dto.customer_area_slug?.trim() || null;
    const { fee: resolvedVisit, serves_area: chefServesArea } = resolveVisitFee(
      cook,
      customerArea,
    );
    const visitFee =
      bookingType === BookingType.HOME_COOKING ? resolvedVisit : 0;
    const convenienceFee = Math.round(subtotal * CONVENIENCE_RATE);
    const totalPrice = subtotal + visitFee + convenienceFee;

    if (!chefServesArea && customerArea && bookingType === BookingType.HOME_COOKING) {
      this.logger.warn(
        `[area-mismatch] Booking by user ${userId} for cook ${dto.cook_id} ` +
          `in area '${customerArea}' — chef does not list this area. Soft-allowed.`,
      );
    }

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
      customer_area_slug: customerArea,
      dishes: selectedDishNames.length > 0
        ? selectedDishNames.join(', ')
        : (dto.dishes || null),
      instructions: dto.instructions,
      order_items: orderItemsForDb,
      subtotal,
      platform_fee: convenienceFee,
      total_price: totalPrice,
      status: BookingStatus.PENDING_CHEF_APPROVAL,
      visit_fee: visitFee,
      platform_fee_percent: 2.5,
      is_package_booking: false,
    });

    const saved = await this.bookingsRepository.save(booking);

    this.notificationsService
      .notifyBookingCreated(userId, cook.user_id, saved.id, customer?.name || 'A customer')
      .catch((err) => this.logger.warn(`Notification failed: ${err.message}`));

    if (customer?.email) {
      this.sendBookingReceiptEmail(
        customer.email,
        customer.name || 'Customer',
        saved.id,
        cook.user?.name || 'Your Chef',
        scheduledDate,
        dto.address,
        selectedDishNames.length > 0
          ? selectedDishNames
          : (dto.dishes ? dto.dishes.split(',').map((d) => d.trim()) : []),
        subtotal,
        visitFee,
        convenienceFee,
        totalPrice,
        dto.duration_hours || 2,
        dto.guests || 2,
      ).catch((err) => this.logger.warn(`Receipt email failed: ${err.message}`));
    }

    return this.findById(saved.id);
  }

  // ─── GET USER BOOKINGS ────────────────────────────────
  async getUserBookings(userId: string, dto: GetBookingsDto) {
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
    const sanitized = bookings.map((b) => this.stripInternalFields(b));

    return {
      bookings: sanitized,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  // ─── GET COOK BOOKINGS ────────────────────────────────
  async getCookBookings(userId: string, dto: GetBookingsDto) {
    const cook = await this.cooksRepository.findOne({
      where: { user_id: userId },
    });
    if (!cook) throw new NotFoundException('Cook profile not found');

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
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  async findByIdForCustomer(id: string) {
    const b = await this.findById(id);
    return this.stripInternalFields(b);
  }

  // ═══════════════════════════════════════════════════════
  // CHEF ACCEPT / REJECT
  // ═══════════════════════════════════════════════════════

  async acceptBooking(bookingId: string, userId: string) {
    const booking = await this.findById(bookingId);

    const cook = await this.cooksRepository.findOne({ where: { user_id: userId } });
    if (!cook || booking.cook_id !== cook.id) {
      throw new ForbiddenException('Only the assigned chef can accept this booking');
    }

    const maybeExpired = await this.expireIfLapsed(booking);
    if (maybeExpired.status === BookingStatus.EXPIRED) {
      throw new BadRequestException('This booking has expired and can no longer be accepted');
    }

    if (
      booking.status !== BookingStatus.PENDING_CHEF_APPROVAL &&
      booking.status !== BookingStatus.PENDING
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

  async rejectBooking(bookingId: string, userId: string, dto: RejectBookingDto) {
    const booking = await this.findById(bookingId);

    const cook = await this.cooksRepository.findOne({ where: { user_id: userId } });
    if (!cook || booking.cook_id !== cook.id) {
      throw new ForbiddenException('Only the assigned chef can reject this booking');
    }

    if (
      booking.status !== BookingStatus.PENDING_CHEF_APPROVAL &&
      booking.status !== BookingStatus.PENDING
    ) {
      throw new BadRequestException(
        `Cannot reject a booking in status "${booking.status}"`,
      );
    }

    const now = new Date();
    booking.status = BookingStatus.CANCELLED_BY_COOK;
    booking.cancelled_at = now;
    booking.chef_responded_at = now;
    booking.rejection_reason = dto.reason;
    booking.cancellation_reason = null;

    await this.bookingsRepository.save(booking);

    this.notificationsService
      .notifyChefRejected(
        booking.user_id,
        booking.user?.email || null,
        bookingId,
        booking.cook?.user?.name || 'The chef',
      )
      .catch((err) => this.logger.warn(`Reject notification failed: ${err.message}`));

    return this.stripInternalFields(booking);
  }

  // ═══════════════════════════════════════════════════════
  // REBOOK WITH A DIFFERENT CHEF
  // ═══════════════════════════════════════════════════════

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
      throw new BadRequestException('Only rejected or expired bookings can be rebooked');
    }

    if (original.rebooked_to_id) {
      throw new BadRequestException('This booking has already been rebooked');
    }

    if (dto.new_cook_id === original.cook_id) {
      throw new BadRequestException('Please choose a different chef');
    }

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

    await this.bookingsRepository.update(originalBookingId, {
      rebooked_to_id: created.id,
    });

    return this.findByIdForCustomer(created.id);
  }

  // ═══════════════════════════════════════════════════════
  // ON-DEMAND EXPIRY
  // ═══════════════════════════════════════════════════════

  async expireIfLapsed(booking: Booking): Promise<Booking> {
    if (!EXPIRABLE_STATUSES.includes(booking.status)) return booking;

    const now = Date.now();

    if (
      booking.status === BookingStatus.PENDING_CHEF_APPROVAL ||
      booking.status === BookingStatus.PENDING
    ) {
      const createdMs = new Date(booking.created_at).getTime();
      if (now - createdMs >= CHEF_APPROVAL_WINDOW_MS) {
        booking.status = BookingStatus.EXPIRED;
        booking.cancelled_at = new Date();
        await this.bookingsRepository.save(booking);
        this.fireExpiryNotifications(booking).catch(() => undefined);
      }
      return booking;
    }

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
    await this.notificationsService.notifyBookingExpired(
      booking.user_id,
      booking.user?.email || null,
      booking.id,
      'customer',
    );
    if (booking.cook?.user_id) {
      await this.notificationsService.notifyBookingExpired(
        booking.cook.user_id,
        booking.cook.user?.email || null,
        booking.id,
        'chef',
      );
    }
  }

  private stripInternalFields(b: Booking): Booking {
    const safe: any = { ...b };
    safe.rejection_reason = null;
    return safe as Booking;
  }

  // ─── UPDATE BOOKING STATUS ────────────────────────────
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

    this.validateStatusTransition(booking.status, dto.status, isUser, isCook, isAdmin);

    if (dto.status === BookingStatus.CONFIRMED && !isAdmin) {
      throw new ForbiddenException(
        'Booking can only be confirmed by payment capture. Chef must use /accept.',
      );
    }

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
        {
          const { refund, chefCompensation } = this.getCancellationRefund(booking);
          booking.refund_amount = refund;
          booking.chef_cancellation_fee = chefCompensation;
        }
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
        booking.chef_cancellation_fee = 0;
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

  // ═══════════════════════════════════════════════════════
  // P1.5d — INGREDIENT REMINDER (called by SchedulerService cron)
  // Finds confirmed package bookings scheduled ~2h from now that
  // haven't had a reminder sent, sends ingredient email, marks flag.
  // ═══════════════════════════════════════════════════════
  async sendIngredientReminders(): Promise<void> {
    const now = new Date();
    // Window: bookings starting between now+1h45m and now+2h15m
    const windowStart = new Date(now.getTime() + 105 * 60 * 1000); // now + 1h45m
    const windowEnd = new Date(now.getTime() + 135 * 60 * 1000);   // now + 2h15m

    const bookings = await this.bookingsRepository.find({
      where: {
        status: BookingStatus.CONFIRMED,
        is_package_booking: true,
        ingredient_reminder_sent: false,
        scheduled_at: Between(windowStart, windowEnd),
      },
      relations: ['user', 'cook', 'cook.user'],
    });

    for (const booking of bookings) {
      try {
        // Fetch the package to get ingredient_notes
        const pkg = booking.package_id
          ? await this.mealPackagesRepository.findOne({ where: { id: booking.package_id } })
          : null;

        const ingredientNotes = pkg?.ingredient_note || null;

        if (booking.user?.email && ingredientNotes) {
          await this.sendIngredientReminderEmail(
            booking.user.email,
            booking.user.name || 'Customer',
            booking.cook?.user?.name || 'Your Chef',
            booking.scheduled_at,
            ingredientNotes,
            booking.id,
          );
        }

        // Mark sent so cron doesn't double-fire
        await this.bookingsRepository.update(booking.id, {
          ingredient_reminder_sent: true,
        });

        this.logger.log(`Ingredient reminder sent for booking ${booking.id}`);
      } catch (err) {
        this.logger.warn(`Ingredient reminder failed for ${booking.id}: ${err?.message}`);
      }
    }
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
      [BookingStatus.PENDING]: [
        BookingStatus.AWAITING_PAYMENT,
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
      throw new BadRequestException(`Cannot transition from ${current} to ${next}`);
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

  // ─── CANCELLATION REFUND (Refund Policy v2 — LOCKED) ─
  getCancellationRefund(booking: Booking): {
    refund: number;
    chefCompensation: number;
  } {
    const hoursUntil =
      (new Date(booking.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60);
    const total = Number(booking.total_price);

    let refundPct: number;
    let chefCompensation: number;

    if (hoursUntil >= 24) { refundPct = 1.0; chefCompensation = 0; }
    else if (hoursUntil >= 8) { refundPct = 0.75; chefCompensation = 25; }
    else if (hoursUntil >= 4) { refundPct = 0.5; chefCompensation = 50; }
    else if (hoursUntil >= 2) { refundPct = 0.25; chefCompensation = 75; }
    else { refundPct = 0; chefCompensation = 100; }

    const refund = Math.round(total * refundPct * 100) / 100;
    return { refund, chefCompensation };
  }

  // ─── INGREDIENT REMINDER EMAIL (P1.5d) ───────────────
  private async sendIngredientReminderEmail(
    email: string,
    customerName: string,
    chefName: string,
    scheduledAt: Date,
    ingredientNotes: string,
    bookingId: string,
  ) {
    if (!this.brevoApiKey) {
      this.logger.warn(`BREVO_API_KEY not set — skipping ingredient reminder for ${email}`);
      return;
    }

    const timeStr = scheduledAt.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit',
    });
    const dateStr = scheduledAt.toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    const shortId = bookingId.slice(0, 8).toUpperCase();

    // Render ingredient list as HTML
    const ingredientHtml = ingredientNotes
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => `<li style="padding:3px 0;color:#5D4E37;">${line.trim()}</li>`)
      .join('');

    const html = `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;background:#FFF8F0;border-radius:16px;padding:40px 32px;border:1px solid #FFE4B5;">
        <div style="text-align:center;margin-bottom:20px;">
          <span style="font-weight:900;font-size:24px;color:#2D1810;">COOK</span><span style="font-weight:900;font-size:24px;color:#D4721A;">ONCALL</span>
        </div>
        <h2 style="text-align:center;color:#2D1810;font-size:20px;margin-bottom:8px;">🛒 Ingredient List — Session in 2 Hours!</h2>
        <p style="text-align:center;color:#8B7355;font-size:14px;margin-bottom:20px;">
          Hi ${customerName}! <strong>${chefName}</strong> is arriving today (${dateStr}) at <strong>${timeStr}</strong> (Booking #${shortId}).<br/>Please ensure these ingredients are ready at home.
        </p>
        <div style="background:white;border-radius:12px;padding:20px;border:1px solid #FFE4B5;margin-bottom:20px;">
          <h3 style="color:#2D1810;font-size:15px;margin:0 0 12px;">🥘 Ingredients Needed</h3>
          <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.8;">
            ${ingredientHtml || '<li style="color:#8B7355;">Chef will carry all ingredients.</li>'}
          </ul>
        </div>
        <div style="background:rgba(212,114,26,0.06);border-radius:10px;padding:14px;font-size:13px;color:#8B7355;line-height:1.6;">
          <strong style="color:#2D1810;">CookOnCall HYBRID model</strong> — Chef brings their tools &amp; expertise; you provide ingredients at actual market cost (with receipt). This keeps your food fresh &amp; cost transparent.
        </div>
        <hr style="border:none;border-top:1px solid #FFE4B5;margin:24px 0;"/>
        <p style="text-align:center;color:#B0A090;font-size:11px;">&copy; ${new Date().getFullYear()} CookOnCall &middot; Ahmedabad, Gujarat, India</p>
      </div>
    `;

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': this.brevoApiKey },
      body: JSON.stringify({
        sender: { name: 'CookOnCall', email: 'support@thecookoncall.com' },
        to: [{ email }],
        subject: `🛒 Ingredients Needed — Your Chef Arrives in 2 Hours! (#${shortId})`,
        htmlContent: html,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      this.logger.error(`Brevo ingredient reminder error: ${JSON.stringify(err)}`);
    }
  }

  // ─── SEND COOKING OTP EMAIL ───────────────────────────
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
    const subject = isStart ? 'Your Cooking Session OTP - Start' : 'Your Cooking Session OTP - End';
    const heading = isStart ? 'Cooking Session Starting!' : 'Cooking Session Ending';
    const message = isStart
      ? `${chefName} is ready to start cooking! Share this OTP with your chef to begin the session.`
      : `${chefName} has finished cooking. Share this OTP with your chef to end the session.`;

    const html = `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:480px;margin:0 auto;background:#FFF8F0;border-radius:16px;padding:40px 32px;border:1px solid #FFE4B5;">
        <div style="text-align:center;margin-bottom:24px;">
          <span style="font-weight:900;font-size:24px;color:#2D1810;">COOK</span><span style="font-weight:900;font-size:24px;color:#D4721A;">ONCALL</span>
        </div>
        <h2 style="text-align:center;color:#2D1810;font-size:20px;margin-bottom:8px;">${heading}</h2>
        <p style="text-align:center;color:#8B7355;font-size:14px;line-height:1.6;margin-bottom:24px;">${message}</p>
        <div style="background:white;border-radius:12px;padding:20px;text-align:center;border:2px dashed #FFB347;margin-bottom:24px;">
          <div style="font-size:36px;font-weight:900;letter-spacing:8px;color:#D4721A;">${otp}</div>
          <div style="font-size:12px;color:#8B7355;margin-top:8px;">Valid for 10 minutes</div>
        </div>
        <p style="text-align:center;color:#B0A090;font-size:12px;">Do not share this OTP with anyone other than your chef.</p>
        <hr style="border:none;border-top:1px solid #FFE4B5;margin:24px 0;"/>
        <p style="text-align:center;color:#B0A090;font-size:11px;">&copy; ${new Date().getFullYear()} CookOnCall</p>
      </div>
    `;

    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': this.brevoApiKey },
      body: JSON.stringify({
        sender: { name: 'CookOnCall', email: 'support@thecookoncall.com' },
        to: [{ email }],
        subject,
        htmlContent: html,
      }),
    });
  }

  // ─── BOOKING RECEIPT EMAIL ────────────────────────────
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
    packageName?: string,
  ) {
    if (!this.brevoApiKey) return;

    const dateStr = scheduledAt.toLocaleDateString('en-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const timeStr = scheduledAt.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit',
    });
    const dishListHtml = dishes.length > 0
      ? dishes.map((d) => `<li style="padding:4px 0;color:#5D4E37;">${d}</li>`).join('')
      : '<li style="padding:4px 0;color:#8B7355;">As discussed with chef</li>';
    const shortId = bookingId.slice(0, 8).toUpperCase();

    const packageRow = packageName
      ? `<tr><td style="padding:8px 0;color:#8B7355;">Package</td><td style="padding:8px 0;color:#2D1810;font-weight:600;">${packageName}</td></tr>`
      : '';

    const html = `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;background:#FFF8F0;border-radius:16px;padding:40px 32px;border:1px solid #FFE4B5;">
        <div style="text-align:center;margin-bottom:24px;">
          <span style="font-weight:900;font-size:24px;color:#2D1810;">COOK</span><span style="font-weight:900;font-size:24px;color:#D4721A;">ONCALL</span>
        </div>
        <h2 style="text-align:center;color:#2D1810;font-size:20px;margin-bottom:8px;">Booking Request Received</h2>
        <p style="text-align:center;color:#8B7355;font-size:14px;margin-bottom:24px;">Thank you, ${customerName}! Your request has been sent to the chef.</p>
        <div style="background:white;border-radius:12px;padding:20px;border:1px solid #FFE4B5;margin-bottom:16px;">
          <table style="width:100%;font-size:14px;border-collapse:collapse;">
            <tr><td style="padding:8px 0;color:#8B7355;width:40%;">Booking ID</td><td style="padding:8px 0;color:#2D1810;font-weight:600;">#${shortId}</td></tr>
            <tr><td style="padding:8px 0;color:#8B7355;">Chef</td><td style="padding:8px 0;color:#2D1810;font-weight:600;">${chefName}</td></tr>
            ${packageRow}
            <tr><td style="padding:8px 0;color:#8B7355;">Date</td><td style="padding:8px 0;color:#2D1810;">${dateStr}</td></tr>
            <tr><td style="padding:8px 0;color:#8B7355;">Time</td><td style="padding:8px 0;color:#2D1810;">${timeStr}</td></tr>
            <tr><td style="padding:8px 0;color:#8B7355;">Duration</td><td style="padding:8px 0;color:#2D1810;">${durationHours} hours</td></tr>
            <tr><td style="padding:8px 0;color:#8B7355;">Guests</td><td style="padding:8px 0;color:#2D1810;">${guests}</td></tr>
            <tr><td style="padding:8px 0;color:#8B7355;vertical-align:top;">Address</td><td style="padding:8px 0;color:#2D1810;">${address}</td></tr>
          </table>
        </div>
        <div style="background:white;border-radius:12px;padding:20px;border:1px solid #FFE4B5;margin-bottom:16px;">
          <h3 style="color:#2D1810;font-size:15px;margin:0 0 12px;">Selected Dishes</h3>
          <ul style="margin:0;padding-left:20px;font-size:14px;">${dishListHtml}</ul>
        </div>
        <div style="background:white;border-radius:12px;padding:20px;border:1px solid #FFE4B5;margin-bottom:24px;">
          <table style="width:100%;font-size:14px;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#8B7355;">Subtotal</td><td style="padding:6px 0;color:#2D1810;text-align:right;">&#8377;${subtotal.toFixed(2)}</td></tr>
            ${visitFee > 0 ? `<tr><td style="padding:6px 0;color:#8B7355;">Visit fee</td><td style="padding:6px 0;color:#2D1810;text-align:right;">&#8377;${visitFee.toFixed(2)}</td></tr>` : ''}
            <tr><td style="padding:6px 0;color:#8B7355;">Convenience fee (2.5%)</td><td style="padding:6px 0;color:#2D1810;text-align:right;">&#8377;${platformFee.toFixed(2)}</td></tr>
            <tr><td colspan="2"><hr style="border:none;border-top:1px dashed #FFE4B5;margin:8px 0;"/></td></tr>
            <tr><td style="padding:6px 0;color:#2D1810;font-weight:700;font-size:16px;">Total</td><td style="padding:6px 0;color:#D4721A;font-weight:700;font-size:16px;text-align:right;">&#8377;${total.toFixed(2)}</td></tr>
            <tr><td colspan="2" style="padding:6px 0;color:#8B7355;font-size:11px;font-style:italic;">+ Ingredients at actual market cost (with receipt)</td></tr>
          </table>
        </div>
        <p style="text-align:center;color:#8B7355;font-size:13px;line-height:1.6;margin-bottom:16px;">Your chef has 3 hours to accept or decline. Payment will only be requested after the chef accepts.</p>
        <hr style="border:none;border-top:1px solid #FFE4B5;margin:24px 0;"/>
        <p style="text-align:center;color:#B0A090;font-size:11px;">&copy; ${new Date().getFullYear()} CookOnCall &middot; Ahmedabad, Gujarat, India</p>
      </div>
    `;

    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': this.brevoApiKey },
      body: JSON.stringify({
        sender: { name: 'CookOnCall', email: 'support@thecookoncall.com' },
        to: [{ email }],
        subject: `Booking Request — #${shortId} | CookOnCall`,
        htmlContent: html,
      }),
    });
  }
}
