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
}
