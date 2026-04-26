import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MealPackagesService } from './meal-packages.service';
import { MealPackagesController } from './meal-packages.controller';
import { MealPackage } from './meal-package.entity';
import { PackageCategory } from './package-category.entity';
import { PackageCategoryDish } from './package-category-dish.entity';
import { PackageAddon } from './package-addon.entity';
import { Cook } from '../cooks/cook.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MealPackage,
      PackageCategory,
      PackageCategoryDish,
      PackageAddon,
      Cook, // needed to resolve user_id → cook.id
    ]),
  ],
  controllers: [MealPackagesController],
  providers: [MealPackagesService],
  exports: [MealPackagesService], // exported for P1.5c booking integration
})
export class MealPackagesModule {}
