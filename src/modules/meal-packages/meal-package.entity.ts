import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Cook } from '../cooks/cook.entity';
import { PackageCategory } from './package-category.entity';
import { PackageAddon } from './package-addon.entity';

// ─── MEAL PACKAGE ────────────────────────────────────────────────────────────
// A pre-priced meal combo created by a chef (e.g., "Gujarati Thali for 4ppl ₹650").
// HYBRID model: chef provides labor + travel; customer sources ingredients.
// Prices are per-guest-tier (2/3/4/5) and locked at booking for 7 days.
// Chef defines categories (e.g. "Pick 1 Dal") → customer picks dishes within them.
// 5% platform commission on payout; refund policy v2 applies.
@Entity('meal_packages')
export class MealPackage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  cook_id: string;

  @ManyToOne(() => Cook, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cook_id' })
  cook: Cook;

  @Column({ length: 150 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  // ─── GUEST-TIER PRICING ──────────────────────────────
  // Chef sets a price per guest count. +₹59 per extra person beyond 5.
  @Column({ type: 'decimal', precision: 8, scale: 2 })
  price_2: number;

  @Column({ type: 'decimal', precision: 8, scale: 2 })
  price_3: number;

  @Column({ type: 'decimal', precision: 8, scale: 2 })
  price_4: number;

  @Column({ type: 'decimal', precision: 8, scale: 2 })
  price_5: number;

  // Per extra person beyond 5 guests (default ₹59, locked in spec)
  @Column({ type: 'decimal', precision: 6, scale: 2, default: 59 })
  extra_person_charge: number;

  // ─── METADATA ────────────────────────────────────────
  @Column({ default: true })
  is_veg: boolean;

  @Column({ default: true })
  is_active: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  cuisine: string;

  // Sent to customer via WhatsApp + email 2h before session.
  // Lists all ingredients they need to arrange.
  @Column({ type: 'text', nullable: true })
  ingredient_note: string;

  // Prices locked at booking for this many days (default 7)
  @Column({ type: 'int', default: 7 })
  price_lock_days: number;

  // ─── RELATIONS ───────────────────────────────────────
  @OneToMany(() => PackageCategory, (cat) => cat.package, {
    cascade: true,
    eager: false,
  })
  categories: PackageCategory[];

  @OneToMany(() => PackageAddon, (addon) => addon.package, {
    cascade: true,
    eager: false,
  })
  addons: PackageAddon[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
