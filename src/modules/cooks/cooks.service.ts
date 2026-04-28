import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cook, VerificationStatus } from './cook.entity';
import { MenuItem } from './menu-item.entity';
import { User, UserRole } from '../users/user.entity';
import { Booking, BookingStatus } from '../bookings/booking.entity';
import {
  CreateCookProfileDto,
  UpdateCookProfileDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  SearchCooksDto,
  SubmitVerificationDto,
} from './dto/cook.dto';

@Injectable()
export class CooksService {
  constructor(
    @InjectRepository(Cook)
    private cooksRepository: Repository<Cook>,
    @InjectRepository(MenuItem)
    private menuRepository: Repository<MenuItem>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Booking)
    private bookingsRepository: Repository<Booking>,
  ) {}

  // ─── CREATE COOK PROFILE ──────────────────────────────
  async createProfile(userId: string, dto: CreateCookProfileDto) {
    const existing = await this.cooksRepository.findOne({
      where: { user_id: userId },
    });

    if (existing) {
      throw new BadRequestException('Cook profile already exists');
    }

    await this.usersRepository.update(userId, { role: UserRole.COOK });

    const cook = this.cooksRepository.create({
      user_id: userId,
      ...dto,
      // New cooks start unverified with not_submitted status
      is_verified: false,
      verification_status: VerificationStatus.NOT_SUBMITTED,
    });

    return this.cooksRepository.save(cook);
  }

  // ─── UPDATE COOK PROFILE ─────────────────────────────
  async updateProfile(userId: string, dto: UpdateCookProfileDto) {
    const cook = await this.findByUserId(userId);

    // ─── P1.6 — Validate service area fields ────────────
    // Fees must be exactly 49 or 79 (per pricing tier).
    // service_area_fees keys must be a subset of service_area_slugs.
    if (dto.service_area_fees && typeof dto.service_area_fees === 'object') {
      const fees = dto.service_area_fees;
      const allowedFees = new Set([49, 79]);
      const targetSlugs = new Set(
        dto.service_area_slugs ?? cook.service_area_slugs ?? [],
      );
      for (const [slug, fee] of Object.entries(fees)) {
        if (!targetSlugs.has(slug)) {
          throw new BadRequestException(
            `Cannot set fee for area '${slug}' — it's not in your service areas.`,
          );
        }
        if (!allowedFees.has(Number(fee))) {
          throw new BadRequestException(
            `Visit fee for '${slug}' must be ₹49 or ₹79.`,
          );
        }
      }
    }

    // If chef sets serves_all_city=true, clear specific area selections
    // (they're redundant and confusing).
    if (dto.serves_all_city === true) {
      cook.service_area_slugs = [];
      cook.service_area_fees = {};
    }

    Object.assign(cook, dto);
    return this.cooksRepository.save(cook);
  }

  // ─── SUBMIT VERIFICATION ─────────────────────────────
  // Chef uploads docs + emergency contact + accepts terms → status goes to PENDING
  async submitVerification(userId: string, dto: SubmitVerificationDto) {
    const cook = await this.findByUserId(userId);

    if (!dto.terms_accepted) {
      throw new BadRequestException('You must accept the Terms and Conditions to proceed');
    }

    // Check profile photo exists (user avatar)
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user?.avatar) {
      throw new BadRequestException('Profile photo is mandatory. Please upload your photo first.');
    }

    // Save verification documents
    cook.aadhaar_url = dto.aadhaar_url;
    cook.pan_url = dto.pan_url;
    cook.address_proof_url = dto.address_proof_url || null;
    cook.fssai_url = dto.fssai_url || null;
    cook.emergency_contact_name = dto.emergency_contact_name;
    cook.emergency_contact_phone = dto.emergency_contact_phone;
    cook.terms_accepted = true;
    cook.terms_accepted_at = new Date();
    cook.verification_status = VerificationStatus.PENDING;
    cook.verification_rejection_reason = null; // Clear any previous rejection

    await this.cooksRepository.save(cook);

    return {
      message: 'Verification documents submitted. Your profile is now under review.',
      verification_status: cook.verification_status,
    };
  }

  // ─── GET VERIFICATION STATUS ──────────────────────────
  async getVerificationStatus(userId: string) {
    const cook = await this.findByUserId(userId);
    return {
      verification_status: cook.verification_status,
      is_verified: cook.is_verified,
      rejection_reason: cook.verification_rejection_reason,
      aadhaar_uploaded: !!cook.aadhaar_url,
      pan_uploaded: !!cook.pan_url,
      address_proof_uploaded: !!cook.address_proof_url,
      fssai_uploaded: !!cook.fssai_url,
      emergency_contact_set: !!cook.emergency_contact_name,
      terms_accepted: cook.terms_accepted,
      profile_photo_set: !!cook.user?.avatar,
    };
  }

  // ─── TOGGLE AVAILABILITY ──────────────────────────────
  async toggleAvailability(userId: string) {
    const cook = await this.findByUserId(userId);

    // Block unverified chefs from going online
    if (!cook.is_verified) {
      throw new BadRequestException(
        'Your profile must be verified before you can go online. Please submit your verification documents.',
      );
    }

    cook.is_available = !cook.is_available;
    await this.cooksRepository.save(cook);
    return { is_available: cook.is_available };
  }

  // ─── GET MY COOK PROFILE ──────────────────────────────
  async getMyProfile(userId: string) {
    return this.findByUserId(userId);
  }

  // ─── SEARCH COOKS (PUBLIC) ────────────────────────────
  async searchCooks(dto: SearchCooksDto) {
    const page = dto.page || 1;
    const limit = dto.limit || 12;
    const skip = (page - 1) * limit;

    const qb = this.cooksRepository
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.user', 'u')
      .where('c.is_verified = true')
      .andWhere('c.is_available = true')
      .andWhere('u.is_active = true');

    // Search by chef name
    if (dto.search) {
      qb.andWhere('u.name ILIKE :search', { search: `%${dto.search}%` });
    }

    // ─── P1.6 — Service area filter ────────────────────────
    // Match chefs who either serve the entire city OR have this area
    // in their service_area_slugs array. Chefs with empty slugs +
    // serves_all_city=false are invisible (intended migration default).
    if (dto.area) {
      qb.andWhere(
        '(c.serves_all_city = TRUE OR :areaSlug = ANY(c.service_area_slugs))',
        { areaSlug: dto.area },
      );
    } else {
      // No area specified → still hide chefs with no areas + not all-city.
      // Otherwise an unconfigured chef would show up without ever being
      // bookable for anyone.
      qb.andWhere(
        '(c.serves_all_city = TRUE OR cardinality(c.service_area_slugs) > 0)',
      );
    }

    if (dto.city) {
      qb.andWhere('LOWER(c.city) = LOWER(:city)', { city: dto.city });
    }

    if (dto.cuisine) {
      qb.andWhere(':cuisine = ANY(c.cuisines)', { cuisine: dto.cuisine });
    }

    if (dto.veg_only) {
      qb.andWhere('c.is_veg_only = true');
    }

    // Batch B2: min_price / max_price filters removed. Flat ₹49 visit fee model.

    if (dto.min_rating) {
      qb.andWhere('c.rating >= :minRating', { minRating: dto.min_rating });
    }

    // Sorting
    switch (dto.sort_by) {
      case 'rating':
        qb.orderBy('c.rating', 'DESC');
        break;
      case 'bookings':
        qb.orderBy('c.total_bookings', 'DESC');
        break;
      default:
        qb.orderBy('c.rating', 'DESC').addOrderBy('c.total_bookings', 'DESC');
    }

    qb.skip(skip).take(limit);

    const [cooks, total] = await qb.getManyAndCount();

    return {
      cooks,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
    };
  }

  // ─── GET COOK BY ID (PUBLIC) ──────────────────────────
  async getCookById(cookId: string) {
    const cook = await this.cooksRepository.findOne({
      where: { id: cookId },
      relations: ['user'],
    });

    if (!cook) {
      throw new NotFoundException('Cook not found');
    }

    return cook;
  }

  // ─── GET COOK MENU ────────────────────────────────────
  async getCookMenu(cookId: string) {
    return this.menuRepository.find({
      where: { cook_id: cookId, is_available: true },
      order: { category: 'ASC', name: 'ASC' },
    });
  }

  // ─── ADD MENU ITEM ────────────────────────────────────
  async addMenuItem(userId: string, dto: CreateMenuItemDto) {
    const cook = await this.findByUserId(userId);

    const item = this.menuRepository.create({
      cook_id: cook.id,
      ...dto,
    });

    return this.menuRepository.save(item);
  }

  // ─── UPDATE MENU ITEM ────────────────────────────────
  async updateMenuItem(
    userId: string,
    itemId: string,
    dto: UpdateMenuItemDto,
  ) {
    const cook = await this.findByUserId(userId);
    const item = await this.menuRepository.findOne({
      where: { id: itemId, cook_id: cook.id },
    });

    if (!item) {
      throw new NotFoundException('Menu item not found');
    }

    Object.assign(item, dto);
    return this.menuRepository.save(item);
  }

  // ─── DELETE MENU ITEM ─────────────────────────────────
  async deleteMenuItem(userId: string, itemId: string) {
    const cook = await this.findByUserId(userId);
    const item = await this.menuRepository.findOne({
      where: { id: itemId, cook_id: cook.id },
    });

    if (!item) {
      throw new NotFoundException('Menu item not found');
    }

    await this.menuRepository.remove(item);
    return { message: 'Menu item deleted' };
  }

  // ─── GET MY EARNINGS ──────────────────────────────────
  async getMyEarnings(userId: string) {
    const cook = await this.findByUserId(userId);

    const totalResult = await this.bookingsRepository
      .createQueryBuilder('b')
      .select('COALESCE(SUM(b.subtotal - b.platform_fee), 0)', 'total')
      .where('b.cook_id = :cookId', { cookId: cook.id })
      .andWhere('b.status = :status', { status: BookingStatus.COMPLETED })
      .getRawOne();

    const monthResult = await this.bookingsRepository
      .createQueryBuilder('b')
      .select('COALESCE(SUM(b.subtotal - b.platform_fee), 0)', 'total')
      .where('b.cook_id = :cookId', { cookId: cook.id })
      .andWhere('b.status = :status', { status: BookingStatus.COMPLETED })
      .andWhere('b.completed_at >= date_trunc(\'month\', NOW())')
      .getRawOne();

    const weekResult = await this.bookingsRepository
      .createQueryBuilder('b')
      .select('COALESCE(SUM(b.subtotal - b.platform_fee), 0)', 'total')
      .where('b.cook_id = :cookId', { cookId: cook.id })
      .andWhere('b.status = :status', { status: BookingStatus.COMPLETED })
      .andWhere('b.completed_at >= date_trunc(\'week\', NOW())')
      .getRawOne();

    const completedBookings = await this.bookingsRepository.find({
      where: { cook_id: cook.id, status: BookingStatus.COMPLETED },
      relations: ['user'],
      order: { completed_at: 'DESC' },
      take: 20,
    });

    return {
      total_earnings: parseFloat(totalResult?.total || '0'),
      month_earnings: parseFloat(monthResult?.total || '0'),
      week_earnings: parseFloat(weekResult?.total || '0'),
      completed_jobs: completedBookings,
    };
  }

  // ─── GET MY STATS ─────────────────────────────────────
  async getMyStats(userId: string) {
    const cook = await this.findByUserId(userId);

    const pending = await this.bookingsRepository.count({
      where: [
        { cook_id: cook.id, status: BookingStatus.PENDING_CHEF_APPROVAL },
        { cook_id: cook.id, status: BookingStatus.AWAITING_PAYMENT },
        { cook_id: cook.id, status: BookingStatus.PENDING }, // legacy
      ],
    });

    const completed = await this.bookingsRepository.count({
      where: { cook_id: cook.id, status: BookingStatus.COMPLETED },
    });

    return {
      pending_requests: pending,
      completed_bookings: completed,
      total_bookings: cook.total_bookings,
      rating: cook.rating,
      total_reviews: cook.total_reviews,
      is_available: cook.is_available,
      is_verified: cook.is_verified,
      verification_status: cook.verification_status,
    };
  }

  // ─── HELPER ───────────────────────────────────────────
  async findByUserId(userId: string): Promise<Cook> {
    const cook = await this.cooksRepository.findOne({
      where: { user_id: userId },
      relations: ['user'],
    });

    if (!cook) {
      throw new NotFoundException('Cook profile not found');
    }

    return cook;
  }

  // ─── P1.6 — Visit fee for a (chef, customer area) pair ──
  // Returns the visit fee the customer should pay, plus whether the
  // chef actually services that area. Used by BookingsService and by
  // frontend to display the right amount per chef on the booking form.
  computeVisitFee(
    cook: Pick<Cook, 'service_area_slugs' | 'serves_all_city' | 'service_area_fees'>,
    customerAreaSlug: string | null | undefined,
  ): { fee: number; serves_area: boolean } {
    const DEFAULT_FEE = 49;
    const EXTENDED_FEE = 79;

    // Chef-side: serves_all_city is a "yes to anyone" setting.
    // Without a specific area, we charge the default ₹49.
    if (cook.serves_all_city) {
      // If customer has an area + chef has a per-area override for it, use that.
      if (customerAreaSlug && cook.service_area_fees?.[customerAreaSlug] != null) {
        return {
          fee: Number(cook.service_area_fees[customerAreaSlug]) || DEFAULT_FEE,
          serves_area: true,
        };
      }
      return { fee: DEFAULT_FEE, serves_area: true };
    }

    // Specific service areas only.
    if (!customerAreaSlug) {
      return { fee: DEFAULT_FEE, serves_area: false };
    }

    const slugs = cook.service_area_slugs ?? [];
    const servesArea = slugs.includes(customerAreaSlug);
    if (!servesArea) {
      // Chef does not list this area — customer-facing default.
      return { fee: DEFAULT_FEE, serves_area: false };
    }

    const overriddenFee = cook.service_area_fees?.[customerAreaSlug];
    if (overriddenFee != null) {
      const n = Number(overriddenFee);
      // Defensive: only allow ₹49 or ₹79.
      if (n === DEFAULT_FEE || n === EXTENDED_FEE) {
        return { fee: n, serves_area: true };
      }
    }

    return { fee: DEFAULT_FEE, serves_area: true };
  }
}
