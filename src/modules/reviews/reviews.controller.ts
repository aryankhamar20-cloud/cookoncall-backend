import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { User } from '../users/user.entity';
import { CreateReviewDto } from './dto/review.dto';

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  async createReview(
    @CurrentUser() user: User,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviewsService.createReview(user.id, dto);
  }

  @Public()
  @Get('cook/:cookId')
  async getCookReviews(
    @Param('cookId', ParseUUIDPipe) cookId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.reviewsService.getCookReviews(cookId, page || 1, limit || 10);
  }

  @Get('me')
  async getMyReviews(@CurrentUser() user: User) {
    return this.reviewsService.getMyReviews(user.id);
  }
}
