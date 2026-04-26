import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { PackageCategory } from './package-category.entity';
import { DishType } from '../cooks/menu-item.entity';

// ─── PACKAGE CATEGORY DISH ───────────────────────────────────────────────────
// A single dish option within a category. E.g., "Dal Tadka", "Dal Makhani".
// Customer picks from these dishes per category's min/max rules.
// No individual price — pricing is at package level.
@Entity('package_category_dishes')
export class PackageCategoryDish {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  category_id: string;

  @ManyToOne(() => PackageCategory, (cat) => cat.dishes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'category_id' })
  category: PackageCategory;

  @Column({ length: 150 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  // Reuses DishType enum from menu-item (veg | non_veg)
  @Column({ type: 'enum', enum: DishType, default: DishType.VEG })
  type: DishType;

  @Column({ nullable: true })
  image: string;

  @Column({ type: 'int', default: 0 })
  sort_order: number;

  @Column({ default: true })
  is_available: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
