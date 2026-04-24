import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Review } from './review.entity';
import { Booking, BookingStatus } from '../bookings/booking.entity';
import { Cook } from '../cooks/cook.entity';
import { CreateReviewDto } from './dto/review.dto';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(Review)
    private reviewsRepository: Repository<Review>,
    @InjectRepository(Booking)
    private bookingsRepository: Repository<Booking>,
    @InjectRepository(Cook)
    private cooksRepository: Repository<Cook>,
  ) {}

  async createReview(userId: string, dto: CreateReviewDto) {
    const booking = await this.bookingsRepository.findOne({
      where: { id: dto.booking_id, user_id: userId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status !== BookingStatus.COMPLETED) {
      throw new BadRequestException('Can only review completed bookings');
    }

    // Check if already reviewed
    const existing = await this.reviewsRepository.findOne({
      where: { booking_id: dto.booking_id },
    });

    if (existing) {
      throw new BadRequestException('You have already reviewed this booking');
    }

    const review = this.reviewsRepository.create({
      booking_id: dto.booking_id,
      user_id: userId,
      cook_id: booking.cook_id,
      rating: dto.rating,
      comment: dto.comment,
    });

    await this.reviewsRepository.save(review);

    // Update cook's average rating
    await this.updateCookRating(booking.cook_id);

    return review;
  }

  async getCookReviews(cookId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;

    const [reviews, total] = await this.reviewsRepository.findAndCount({
      where: { cook_id: cookId },
      relations: ['user'],
      order: { created_at: 'DESC' },
      skip,
      take: limit,
    });

    return {
      reviews,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  async getMyReviews(userId: string) {
    return this.reviewsRepository.find({
      where: { user_id: userId },
      relations: ['cook', 'cook.user'],
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Chef-side: reviews the logged-in chef has RECEIVED.
   * Looks up the cook profile by user_id, then fetches reviews for that cook.
   */
  async getReviewsForCookUser(userId: string, page = 1, limit = 20) {
    const cook = await this.cooksRepository.findOne({
      where: { user_id: userId },
    });

    if (!cook) {
      throw new NotFoundException('Cook profile not found for this user');
    }

    const skip = (page - 1) * limit;

    const [reviews, total] = await this.reviewsRepository.findAndCount({
      where: { cook_id: cook.id },
      relations: ['user', 'booking'],
      order: { created_at: 'DESC' },
      skip,
      take: limit,
    });

    // Rating distribution (1★..5★)
    const distribution: Record<string, number> = {
      '1': 0,
      '2': 0,
      '3': 0,
      '4': 0,
      '5': 0,
    };
    const distRows = await this.reviewsRepository
      .createQueryBuilder('r')
      .select('r.rating', 'rating')
      .addSelect('COUNT(*)', 'count')
      .where('r.cook_id = :cookId', { cookId: cook.id })
      .groupBy('r.rating')
      .getRawMany();
    for (const row of distRows) {
      const key = String(Math.round(Number(row.rating)));
      if (distribution[key] !== undefined) {
        distribution[key] = parseInt(row.count, 10);
      }
    }

    return {
      reviews,
      stats: {
        average_rating: Number(cook.rating) || 0,
        total_reviews: cook.total_reviews || 0,
        distribution,
      },
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  }

  private async updateCookRating(cookId: string) {
    const result = await this.reviewsRepository
      .createQueryBuilder('r')
      .select('AVG(r.rating)', 'avg')
      .addSelect('COUNT(*)', 'count')
      .where('r.cook_id = :cookId', { cookId })
      .getRawOne();

    const avgRating = parseFloat(result?.avg || '0');
    const totalReviews = parseInt(result?.count || '0', 10);

    await this.cooksRepository.update(cookId, {
      rating: Math.round(avgRating * 100) / 100,
      total_reviews: totalReviews,
    });
  }
}
