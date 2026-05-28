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

  async updateFcmToken(userId: string, fcmToken: string) {
    await this.usersRepository.update(userId, { fcm_token: fcmToken });
    return { message: 'FCM token updated' };
  }

  async getFcmToken(userId: string): Promise<string | null> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'fcm_token'],
    });
    return user?.fcm_token || null;
  }

  // ─── NOTIFICATION PREFERENCES (Round 4) ─────────────
  /**
   * Returns just the notification flags for the current user. Used by
   * the Settings → Notifications screen on web + Flutter so we don't
   * have to ship the entire user payload (which contains PII) on
   * every settings open.
   */
  async getNotificationPreferences(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'push_enabled', 'email_enabled', 'sms_enabled'],
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      push_enabled: user.push_enabled,
      email_enabled: user.email_enabled,
      sms_enabled: user.sms_enabled,
    };
  }

  /**
   * Patches any subset of {push, email, sms}. We use a TypeORM update
   * (not save) because we don't want to accidentally overwrite other
   * columns the controller didn't touch.
   *
   * Returns the new preferences so the UI can update its local state
   * from the server's truth (in case validation rounded things).
   */
  async updateNotificationPreferences(
    userId: string,
    dto: { push_enabled?: boolean; email_enabled?: boolean; sms_enabled?: boolean },
  ) {
    // Strip undefined so they don't overwrite columns with null.
    const patch: Record<string, boolean> = {};
    if (typeof dto.push_enabled === 'boolean') patch.push_enabled = dto.push_enabled;
    if (typeof dto.email_enabled === 'boolean') patch.email_enabled = dto.email_enabled;
    if (typeof dto.sms_enabled === 'boolean') patch.sms_enabled = dto.sms_enabled;

    if (Object.keys(patch).length > 0) {
      await this.usersRepository.update(userId, patch);
    }
    return this.getNotificationPreferences(userId);
  }

  /** Returns just the channel flags — used by NotificationsService
   *  to decide whether to enqueue email/SMS for a given user. */
  async getChannels(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'email', 'phone', 'fcm_token', 'push_enabled', 'email_enabled', 'sms_enabled'],
    });
    if (!user) return null;
    return user;
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
