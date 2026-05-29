import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MealPackage } from './meal-package.entity';
import { PackageCategory } from './package-category.entity';
import { PackageCategoryDish } from './package-category-dish.entity';
import { PackageAddon } from './package-addon.entity';
import { Cook } from '../cooks/cook.entity';
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
import { RedisCacheService } from '../../common/services/redis-cache.service';

@Injectable()
export class MealPackagesService {
  constructor(
    @InjectRepository(MealPackage)
    private readonly packageRepo: Repository<MealPackage>,
    @InjectRepository(PackageCategory)
    private readonly categoryRepo: Repository<PackageCategory>,
    @InjectRepository(PackageCategoryDish)
    private readonly dishRepo: Repository<PackageCategoryDish>,
    @InjectRepository(PackageAddon)
    private readonly addonRepo: Repository<PackageAddon>,
    @InjectRepository(Cook)
    private readonly cookRepo: Repository<Cook>,
    private readonly cache: RedisCacheService,
  ) {}

  /** Round 3 — bust the public per-cook package list when chef mutates anything. */
  private async _invalidateCookCache(cookId: string): Promise<void> {
    // Key shape: cache:meal-packages:cook|/api/v1/meal-packages/cook/<cookId>|...
    // Prefix scan covers it.
    await this.cache.delByPrefix(`cache:meal-packages:cook`);
  }

  // ─── CHEF: MY PACKAGES ───────────────────────────────────────────────────

  async getMyPackages(userId: string): Promise<MealPackage[]> {
    const cook = await this._resolveCook(userId);
    return this.packageRepo.find({
      where: { cook_id: cook.id },
      relations: ['categories', 'categories.dishes', 'addons'],
      order: { created_at: 'DESC' },
    });
  }

  async createPackage(userId: string, dto: CreateMealPackageDto): Promise<MealPackage> {
    const cook = await this._resolveCook(userId);

    const pkg = this.packageRepo.create({
      cook_id: cook.id,
      name: dto.name,
      description: dto.description,
      price_2: dto.price_2,
      price_3: dto.price_3,
      price_4: dto.price_4,
      price_5: dto.price_5,
      extra_person_charge: dto.extra_person_charge ?? 59,
      is_veg: dto.is_veg ?? true,
      cuisine: dto.cuisine,
      ingredient_note: dto.ingredient_note,
    });

    // Inline categories + dishes
    if (dto.categories?.length) {
      pkg.categories = dto.categories.map((catDto) => {
        const cat = this.categoryRepo.create({
          name: catDto.name,
          min_selections: catDto.min_selections ?? 1,
          max_selections: catDto.max_selections ?? 1,
          is_required: catDto.is_required ?? true,
          sort_order: catDto.sort_order ?? 0,
          dishes: (catDto.dishes ?? []).map((d) => this.dishRepo.create(d)),
        });
        return cat;
      });
    }

    // Inline add-ons
    if (dto.addons?.length) {
      pkg.addons = dto.addons.map((a) => this.addonRepo.create(a));
    }

    const saved = await this.packageRepo.save(pkg);
    this._invalidateCookCache(cook.id).catch((): void => undefined);
    return saved;
  }

  async updatePackage(
    userId: string,
    packageId: string,
    dto: UpdateMealPackageDto,
  ): Promise<MealPackage> {
    const pkg = await this._ownPackage(userId, packageId);
    Object.assign(pkg, dto);
    const saved = await this.packageRepo.save(pkg);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
    return saved;
  }

  async deletePackage(userId: string, packageId: string): Promise<void> {
    const pkg = await this._ownPackage(userId, packageId);
    await this.packageRepo.remove(pkg);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
  }

  // ─── CATEGORIES ──────────────────────────────────────────────────────────

  async addCategory(
    userId: string,
    packageId: string,
    dto: CreatePackageCategoryDto,
  ): Promise<PackageCategory> {
    const pkg = await this._ownPackage(userId, packageId);

    const cat = this.categoryRepo.create({
      package_id: packageId,
      name: dto.name,
      min_selections: dto.min_selections ?? 1,
      max_selections: dto.max_selections ?? 1,
      is_required: dto.is_required ?? true,
      sort_order: dto.sort_order ?? 0,
      dishes: (dto.dishes ?? []).map((d) => this.dishRepo.create(d)),
    });

    const saved = await this.categoryRepo.save(cat);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
    return saved;
  }

  async updateCategory(
    userId: string,
    packageId: string,
    categoryId: string,
    dto: UpdatePackageCategoryDto,
  ): Promise<PackageCategory> {
    const pkg = await this._ownPackage(userId, packageId);
    const cat = await this.categoryRepo.findOne({
      where: { id: categoryId, package_id: packageId },
    });
    if (!cat) throw new NotFoundException('Category not found');
    Object.assign(cat, dto);
    const saved = await this.categoryRepo.save(cat);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
    return saved;
  }

  async deleteCategory(
    userId: string,
    packageId: string,
    categoryId: string,
  ): Promise<void> {
    const pkg = await this._ownPackage(userId, packageId);
    const cat = await this.categoryRepo.findOne({
      where: { id: categoryId, package_id: packageId },
    });
    if (!cat) throw new NotFoundException('Category not found');
    await this.categoryRepo.remove(cat);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
  }

  // ─── DISHES ──────────────────────────────────────────────────────────────

  async addDish(
    userId: string,
    packageId: string,
    categoryId: string,
    dto: CreatePackageCategoryDishDto,
  ): Promise<PackageCategoryDish> {
    const pkg = await this._ownPackage(userId, packageId);
    const cat = await this.categoryRepo.findOne({
      where: { id: categoryId, package_id: packageId },
    });
    if (!cat) throw new NotFoundException('Category not found');
    const dish = this.dishRepo.create({ ...dto, category_id: categoryId });
    const saved = await this.dishRepo.save(dish);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
    return saved;
  }

  async updateDish(
    userId: string,
    packageId: string,
    categoryId: string,
    dishId: string,
    dto: UpdatePackageCategoryDishDto,
  ): Promise<PackageCategoryDish> {
    const pkg = await this._ownPackage(userId, packageId);
    const dish = await this.dishRepo.findOne({
      where: { id: dishId, category_id: categoryId },
    });
    if (!dish) throw new NotFoundException('Dish not found');
    Object.assign(dish, dto);
    const saved = await this.dishRepo.save(dish);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
    return saved;
  }

  async deleteDish(
    userId: string,
    packageId: string,
    categoryId: string,
    dishId: string,
  ): Promise<void> {
    const pkg = await this._ownPackage(userId, packageId);
    const dish = await this.dishRepo.findOne({
      where: { id: dishId, category_id: categoryId },
    });
    if (!dish) throw new NotFoundException('Dish not found');
    await this.dishRepo.remove(dish);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
  }

  // ─── ADD-ONS ─────────────────────────────────────────────────────────────

  async addAddon(
    userId: string,
    packageId: string,
    dto: CreatePackageAddonDto,
  ): Promise<PackageAddon> {
    const pkg = await this._ownPackage(userId, packageId);
    const addon = this.addonRepo.create({ ...dto, package_id: packageId });
    const saved = await this.addonRepo.save(addon);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
    return saved;
  }

  async updateAddon(
    userId: string,
    packageId: string,
    addonId: string,
    dto: UpdatePackageAddonDto,
  ): Promise<PackageAddon> {
    const pkg = await this._ownPackage(userId, packageId);
    const addon = await this.addonRepo.findOne({
      where: { id: addonId, package_id: packageId },
    });
    if (!addon) throw new NotFoundException('Add-on not found');
    Object.assign(addon, dto);
    const saved = await this.addonRepo.save(addon);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
    return saved;
  }

  async deleteAddon(
    userId: string,
    packageId: string,
    addonId: string,
  ): Promise<void> {
    const pkg = await this._ownPackage(userId, packageId);
    const addon = await this.addonRepo.findOne({
      where: { id: addonId, package_id: packageId },
    });
    if (!addon) throw new NotFoundException('Add-on not found');
    await this.addonRepo.remove(addon);
    this._invalidateCookCache(pkg.cook_id).catch((): void => undefined);
  }

  // ─── PUBLIC ──────────────────────────────────────────────────────────────

  // Called by customer-facing chef profile (P1.5c)
  async getCookPackages(cookId: string): Promise<MealPackage[]> {
    return this.packageRepo.find({
      where: { cook_id: cookId, is_active: true },
      relations: ['categories', 'categories.dishes', 'addons'],
      order: { created_at: 'ASC' },
    });
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────

  private async _resolveCook(userId: string): Promise<Cook> {
    const cook = await this.cookRepo.findOne({ where: { user_id: userId } });
    if (!cook) throw new NotFoundException('Cook profile not found');
    return cook;
  }

  private async _ownPackage(userId: string, packageId: string): Promise<MealPackage> {
    const cook = await this._resolveCook(userId);
    const pkg = await this.packageRepo.findOne({ where: { id: packageId } });
    if (!pkg) throw new NotFoundException('Package not found');
    if (pkg.cook_id !== cook.id) throw new ForbiddenException('Not your package');
    return pkg;
  }
  async getActivePackagesByCook(cookId: string) {
    return this.packageRepo.find({
      where: { cook_id:  cookId, is_active: true },
      relations: ['categories', 'categories.dishes', 'addons'],
      order: { created_at: 'ASC' },
    });
  }
}
