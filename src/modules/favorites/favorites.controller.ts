import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { FavoritesService } from './favorites.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';

/**
 * Customer favorites (saved chefs). Auth is enforced by the global
 * JwtAuthGuard (routes are protected by default; @Public opts out).
 */
@Controller('favorites')
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  /** Full saved-chef objects (newest first). */
  @Get()
  async list(@CurrentUser() user: User) {
    return this.favoritesService.list(user.id);
  }

  /** Just the favorited cook ids — for hydrating heart states cheaply. */
  @Get('ids')
  async listIds(@CurrentUser() user: User) {
    return this.favoritesService.listIds(user.id);
  }

  /** Toggle favorite on/off. Returns { favorited: boolean }. */
  @Post(':cookId')
  async toggle(
    @CurrentUser() user: User,
    @Param('cookId', ParseUUIDPipe) cookId: string,
  ) {
    return this.favoritesService.toggle(user.id, cookId);
  }

  @Delete(':cookId')
  async remove(
    @CurrentUser() user: User,
    @Param('cookId', ParseUUIDPipe) cookId: string,
  ) {
    return this.favoritesService.remove(user.id, cookId);
  }
}
