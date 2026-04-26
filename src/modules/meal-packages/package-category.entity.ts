import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { MealPackage } from './meal-package.entity';
import { PackageCategoryDish } from './package-category-dish.entity';

// ─── PACKAGE CATEGORY ────────────────────────────────────────────────────────
// A selection group within a package. E.g., "Pick 1 Dal", "Pick 2 Sabzis".
// min_selections / max_selections define how many dishes the customer must/can choose.
@Entity('package_categories')
export class PackageCategory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  package_id: string;

  @ManyToOne(() => MealPackage, (pkg) => pkg.categories, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package: MealPackage;

  // e.g., "Pick 1 Dal", "Choose Your Sabzi"
  @Column({ length: 150 })
  name: string;

  // Minimum dishes customer must select from this category
  @Column({ type: 'int', default: 1 })
  min_selections: number;

  // Maximum dishes customer can select from this category
  @Column({ type: 'int', default: 1 })
  max_selections: number;

  // If true, customer MUST select from this category to proceed
  @Column({ default: true })
  is_required: boolean;

  // Display order within the package
  @Column({ type: 'int', default: 0 })
  sort_order: number;

  @OneToMany(() => PackageCategoryDish, (dish) => dish.category, {
    cascade: true,
    eager: false,
  })
  dishes: PackageCategoryDish[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
