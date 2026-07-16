import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Favorite } from './favorite.entity';
import { Cook } from '../cooks/cook.entity';

@Injectable()
export class FavoritesService {
  constructor(
    @InjectRepository(Favorite)
    private favoritesRepository: Repository<Favorite>,
    @InjectRepository(Cook)
    private cooksRepository: Repository<Cook>,
  ) {}

  /** Idempotent toggle — favorites the chef if not already, else un-favorites. */
  async toggle(userId: string, cookId: string) {
    const cook = await this.cooksRepository.findOne({ where: { id: cookId } });
    if (!cook) throw new NotFoundException('Chef not found');
    const existing = await this.favoritesRepository.findOne({
      where: { user_id: userId, cook_id: cookId },
    });
    if (existing) {
      await this.favoritesRepository.remove(existing);
      return { favorited: false };
    }
    const fav = this.favoritesRepository.create({
      user_id: userId,
      cook_id: cookId,
    });
    await this.favoritesRepository.save(fav);
    return { favorited: true };
  }

  async remove(userId: string, cookId: string) {
    await this.favoritesRepository.delete({
      user_id: userId,
      cook_id: cookId,
    });
    return { favorited: false };
  }

  /** Full chef objects the customer has saved (newest first). */
  async list(userId: string) {
    const favs = await this.favoritesRepository.find({
      where: { user_id: userId },
      relations: ['cook', 'cook.user'],
      order: { created_at: 'DESC' },
    });
    return favs.map((f) => f.cook).filter((c) => !!c);
  }

  /** Just the favorited cook ids — for cheap "is favorited" checks. */
  async listIds(userId: string): Promise<string[]> {
    const favs = await this.favoritesRepository.find({
      where: { user_id: userId },
      select: ['cook_id'],
    });
    return favs.map((f) => f.cook_id);
  }
}
