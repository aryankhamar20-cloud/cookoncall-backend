import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { Cook } from '../cooks/cook.entity';

/**
 * A customer's saved (favorited) chef. One row per (user, cook) pair —
 * the unique index enforces idempotent "favorite" toggling.
 */
@Entity('favorites')
@Index('uq_favorites_user_cook', ['user_id', 'cook_id'], { unique: true })
export class Favorite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid' })
  cook_id: string;

  @ManyToOne(() => Cook, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cook_id' })
  cook: Cook;

  @CreateDateColumn()
  created_at: Date;
}
