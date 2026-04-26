import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { MealPackage } from './meal-package.entity';
import { DishType } from '../cooks/menu-item.entity';

// ─── PACKAGE ADD-ON ──────────────────────────────────────────────────────────
// Optional extras a customer can add to a package booking.
// E.g., "Extra Roti ₹20", "Papad & Pickle ₹30", "Kheer ₹60".
// Each add-on has its own price (added on top of package price).
@Entity('package_addons')
export class PackageAddon {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  package_id: string;

  @ManyToOne(() => MealPackage, (pkg) => pkg.addons, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package: MealPackage;

  @Column({ length: 150 })
  name: string;

  // Price for this add-on (charged on top of package price)
  @Column({ type: 'decimal', precision: 8, scale: 2 })
  price: number;

  @Column({ type: 'enum', enum: DishType, default: DishType.VEG })
  type: DishType;

  @Column({ default: true })
  is_available: boolean;

  @Column({ type: 'int', default: 0 })
  sort_order: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
