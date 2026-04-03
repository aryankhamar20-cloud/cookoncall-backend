import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cook } from './cook.entity';
import { MenuItem } from './menu-item.entity';
import { User, UserRole } from '../users/user.entity';
import { Booking, BookingStatus } from '../bookings/booking.entity';
import {
  CreateCookProfileDto,
  UpdateCookProfileDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  SearchCooksDto,
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

    // Update user role to cook
    await this.usersRepository.update(userId, { role: UserRole.COOK });

    const cook = this.cooksRepository.create({
      user_id: userId,
      ...dto,
    });

    return this.cooksRepository.save(cook);
  }

  // ─── UPDATE COOK PROFILE ─────────────────────────────
  async updateProfile(userId: string, dto: UpdateCookProfileDto) {
    const cook = await this.findByUserId(userId);
    Object.assign(cook, dto);
    return this.cooksRepository.save(cook);
  }

  // ─── TOGGLE AVAILABILITY ──────────────────────────────
  async toggleAvailability(userId: string) {
    const cook = await this.findByUserId(userId);
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

    if (dto.city) {
      qb.andWhere('LOWER(c.city) = LOWER(:city)', { city: dto.city });
    }

    if (dto.cuisine) {
      qb.andWhere(':cuisine = ANY(c.cuisines)', { cuisine: dto.cuisine });
    }

    if (dto.veg_only) {
      qb.andWhere('c.is_veg_only = true');
    }

    if (dto.min_price) {
      qb.andWhere('c.price_per_session >= :minPrice', { minPrice: dto.min_price });
    }

    if (dto.max_price) {
      qb.andWhere('c.price_per_session <= :maxPrice', { maxPrice: dto.max_price });
    }

    if (dto.min_rating) {
      qb.andWhere('c.rating >= :minRating', { minRating: dto.min_rating });
    }

    qb.orderBy('c.rating', 'DESC')
      .addOrderBy('c.total_bookings', 'DESC')
      .skip(skip)
      .take(limit);

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
      where: { cook_id: cook.id, status: BookingStatus.PENDING },
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
