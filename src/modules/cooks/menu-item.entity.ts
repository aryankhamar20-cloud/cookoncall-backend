import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Cook } from './cook.entity';

export enum DishType {
  VEG = 'veg',
  NON_VEG = 'non_veg',
}

export enum DishCategory {
  STARTER = 'starter',
  MAIN_COURSE = 'main_course',
  BREAD = 'bread',
  RICE = 'rice',
  DESSERT = 'dessert',
  BEVERAGE = 'beverage',
  SNACK = 'snack',
}

@Entity('menu_items')
export class MenuItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  cook_id: string;

  @ManyToOne(() => Cook, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cook_id' })
  cook: Cook;

  @Column({ length: 150 })
  name: string;

  @Column({ type: 'decimal', precision: 8, scale: 2 })
  price: number;

  @Column({ type: 'enum', enum: DishType })
  type: DishType;

  @Column({ type: 'enum', enum: DishCategory, default: DishCategory.MAIN_COURSE })
  category: DishCategory;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ nullable: true })
  image: string;

  @Column({ default: true })
  is_available: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
