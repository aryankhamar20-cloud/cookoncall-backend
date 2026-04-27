import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MealPackagesService } from './meal-packages.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Public } from '../../common/decorators/public.decorator';
import { User, UserRole } from '../users/user.entity';
import {
  CreateMealPackageDto,
  UpdateMealPackageDto,
  CreatePackageCategoryDto,
  UpdatePackageCategoryDto,
  CreatePackageCategoryDishDto,
  UpdatePackageCategoryDishDto,
  CreatePackageAddonDto,
  UpdatePackageAddonDto,
} from './dto/meal-package.dto';

@Controller('meal-packages')
export class MealPackagesController {
  constructor(private readonly svc: MealPackagesService) {}
  @Public()
  @Get('cook/:cookId')
  getCookPackages(@Param('cookId', ParseUUIDPipe) cookId: string) {
    return this.svc.getCookPackages(cookId);
  }

  // ─── CHEF: PACKAGES ──────────────────────────────────────────────────────
  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Get('my')
  getMyPackages(@CurrentUser() user: User) {
    return this.svc.getMyPackages(user.id);
  }

  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Post()
  createPackage(
    @CurrentUser() user: User,
    @Body() dto: CreateMealPackageDto,
  ) {
    return this.svc.createPackage(user.id, dto);
  }

  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Patch(':id')
  updatePackage(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMealPackageDto,
  ) {
    return this.svc.updatePackage(user.id, id, dto);
  }

  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Delete(':id')
  deletePackage(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.deletePackage(user.id, id);
  }

  // ─── CHEF: CATEGORIES ────────────────────────────────────────────────────
  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Post(':id/categories')
  addCategory(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePackageCategoryDto,
  ) {
    return this.svc.addCategory(user.id, id, dto);
  }

  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Patch(':id/categories/:catId')
  updateCategory(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('catId', ParseUUIDPipe) catId: string,
    @Body() dto: UpdatePackageCategoryDto,
  ) {
    return this.svc.updateCategory(user.id, id, catId, dto);
  }

  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Delete(':id/categories/:catId')
  deleteCategory(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('catId', ParseUUIDPipe) catId: string,
  ) {
    return this.svc.deleteCategory(user.id, id, catId);
  }

  // ─── CHEF: DISHES ────────────────────────────────────────────────────────
  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Post(':id/categories/:catId/dishes')
  addDish(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('catId', ParseUUIDPipe) catId: string,
    @Body() dto: CreatePackageCategoryDishDto,
  ) {
    return this.svc.addDish(user.id, id, catId, dto);
  }

  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Patch(':id/categories/:catId/dishes/:dishId')
  updateDish(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('catId', ParseUUIDPipe) catId: string,
    @Param('dishId', ParseUUIDPipe) dishId: string,
    @Body() dto: UpdatePackageCategoryDishDto,
  ) {
    return this.svc.updateDish(user.id, id, catId, dishId, dto);
  }

  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Delete(':id/categories/:catId/dishes/:dishId')
  deleteDish(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('catId', ParseUUIDPipe) catId: string,
    @Param('dishId', ParseUUIDPipe) dishId: string,
  ) {
    return this.svc.deleteDish(user.id, id, catId, dishId);
  }

  // ─── CHEF: ADD-ONS ───────────────────────────────────────────────────────
  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Post(':id/addons')
  addAddon(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePackageAddonDto,
  ) {
    return this.svc.addAddon(user.id, id, dto);
  }

  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Patch(':id/addons/:addonId')
  updateAddon(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addonId', ParseUUIDPipe) addonId: string,
    @Body() dto: UpdatePackageAddonDto,
  ) {
    return this.svc.updateAddon(user.id, id, addonId, dto);
  }

  @Roles(UserRole.COOK)
  @UseGuards(RolesGuard)
  @Delete(':id/addons/:addonId')
  deleteAddon(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addonId', ParseUUIDPipe) addonId: string,
  ) {
    return this.svc.deleteAddon(user.id, id, addonId);
  }
}
