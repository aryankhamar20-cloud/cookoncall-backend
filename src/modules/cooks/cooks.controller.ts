import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CooksService } from './cooks.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Public } from '../../common/decorators/public.decorator';
import { User, UserRole } from '../users/user.entity';
import {
  CreateCookProfileDto,
  UpdateCookProfileDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  SearchCooksDto,
  SubmitVerificationDto,
} from './dto/cook.dto';

@Controller('cooks')
export class CooksController {
  constructor(private readonly cooksService: CooksService) {}

  // ─── PUBLIC ROUTES ────────────────────────────────────

  @Public()
  @Get()
  async searchCooks(@Query() dto: SearchCooksDto) {
    return this.cooksService.searchCooks(dto);
  }

  @Public()
  @Get(':id')
  async getCookById(@Param('id', ParseUUIDPipe) id: string) {
    return this.cooksService.getCookById(id);
  }

  @Public()
  @Get(':id/menu')
  async getCookMenu(@Param('id', ParseUUIDPipe) id: string) {
    return this.cooksService.getCookMenu(id);
  }

  // ─── COOK-ONLY ROUTES ─────────────────────────────────

  @Post('profile')
  async createProfile(
    @CurrentUser() user: User,
    @Body() dto: CreateCookProfileDto,
  ) {
    return this.cooksService.createProfile(user.id, dto);
  }

  @Patch('me')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async updateProfile(
    @CurrentUser() user: User,
    @Body() dto: UpdateCookProfileDto,
  ) {
    return this.cooksService.updateProfile(user.id, dto);
  }

  @Patch('me/availability')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async toggleAvailability(@CurrentUser() user: User) {
    return this.cooksService.toggleAvailability(user.id);
  }

  @Get('me/profile')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async getMyProfile(@CurrentUser() user: User) {
    return this.cooksService.getMyProfile(user.id);
  }

  /** Submit verification documents for admin review */
  @Post('me/submit-verification')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async submitVerification(
    @CurrentUser() user: User,
    @Body() dto: SubmitVerificationDto,
  ) {
    return this.cooksService.submitVerification(user.id, dto);
  }

  /** Check current verification status */
  @Get('me/verification-status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async getVerificationStatus(@CurrentUser() user: User) {
    return this.cooksService.getVerificationStatus(user.id);
  }

  @Get('me/earnings')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async getMyEarnings(@CurrentUser() user: User) {
    return this.cooksService.getMyEarnings(user.id);
  }

  @Get('me/stats')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async getMyStats(@CurrentUser() user: User) {
    return this.cooksService.getMyStats(user.id);
  }

  // ─── MENU CRUD ────────────────────────────────────────

  @Post('me/menu')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async addMenuItem(
    @CurrentUser() user: User,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.cooksService.addMenuItem(user.id, dto);
  }

  @Get('me/menu')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async getMyMenu(@CurrentUser() user: User) {
    const cook = await this.cooksService.findByUserId(user.id);
    return this.cooksService.getCookMenu(cook.id);
  }

  @Patch('me/menu/:itemId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async updateMenuItem(
    @CurrentUser() user: User,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.cooksService.updateMenuItem(user.id, itemId, dto);
  }

  @Delete('me/menu/:itemId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.COOK)
  async deleteMenuItem(
    @CurrentUser() user: User,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.cooksService.deleteMenuItem(user.id, itemId);
  }
}
