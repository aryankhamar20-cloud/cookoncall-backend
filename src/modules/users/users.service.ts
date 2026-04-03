import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { Booking, BookingStatus } from '../bookings/booking.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(Booking)
    private bookingsRepository: Repository<Booking>,
  ) {}

  async findById(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async updateProfile(userId: string, dto: UpdateUserDto) {
    await this.usersRepository.update(userId, dto);
    return this.findById(userId);
  }

  async getUserStats(userId: string) {
    const totalBookings = await this.bookingsRepository.count({
      where: { user_id: userId },
    });

    const completedBookings = await this.bookingsRepository.count({
      where: { user_id: userId, status: BookingStatus.COMPLETED },
    });

    // Total amount spent
    const spentResult = await this.bookingsRepository
      .createQueryBuilder('b')
      .select('COALESCE(SUM(b.total_price), 0)', 'total')
      .where('b.user_id = :userId', { userId })
      .andWhere('b.status = :status', { status: BookingStatus.COMPLETED })
      .getRawOne();

    // Most booked cook
    const favouriteCook = await this.bookingsRepository
      .createQueryBuilder('b')
      .select('b.cook_id', 'cook_id')
      .addSelect('COUNT(*)', 'count')
      .where('b.user_id = :userId', { userId })
      .andWhere('b.status = :status', { status: BookingStatus.COMPLETED })
      .groupBy('b.cook_id')
      .orderBy('count', 'DESC')
      .limit(1)
      .getRawOne();

    let favouriteCookName: string | null = null;
    if (favouriteCook?.cook_id) {
      const cook = await this.bookingsRepository
        .createQueryBuilder('b')
        .leftJoinAndSelect('b.cook', 'c')
        .leftJoinAndSelect('c.user', 'u')
        .where('b.cook_id = :cookId', { cookId: favouriteCook.cook_id })
        .getOne();
      favouriteCookName = cook?.cook?.user?.name || null;
    }

    return {
      total_bookings: totalBookings,
      completed_bookings: completedBookings,
      total_spent: parseFloat(spentResult?.total || '0'),
      favourite_cook: favouriteCookName,
    };
  }
}
