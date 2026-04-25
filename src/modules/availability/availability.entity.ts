import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Cook } from '../cooks/cook.entity';

/**
 * Weekly recurring availability for a chef.
 * One row per (cook, weekday). weekday 0 = Sunday .. 6 = Saturday.
 *
 * If a chef has NO row for a given weekday → unavailable that day.
 * If enabled=false → explicitly closed that day.
 * Times are stored as "HH:mm" strings in IST (all chefs in Ahmedabad for now).
 *
 * A chef can also have multiple time windows in a day (e.g., lunch + dinner)
 * by storing them as JSON array in `windows` — keeps schema simple, no need
 * for a separate slots table.
 */
@Entity('availability_schedules')
@Unique(['cook_id', 'weekday'])
export class AvailabilitySchedule {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  cook_id: string;

  @ManyToOne(() => Cook, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cook_id' })
  cook: Cook;

  /** 0=Sun, 1=Mon, ..., 6=Sat */
  @Column({ type: 'smallint' })
  weekday: number;

  /** If false, chef is closed this weekday. */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * Time windows as JSON. Each window: { start: "HH:mm", end: "HH:mm" }.
   * Multiple allowed (e.g., lunch 11-14 + dinner 18-22).
   * Empty array when enabled=false.
   */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  windows: { start: string; end: string }[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

/**
 * Date-specific override. Takes precedence over the weekly schedule for that date.
 * If `closed=true` → chef unavailable that day regardless of weekly schedule.
 * Otherwise `windows` replace the weekly schedule for that date.
 *
 * Use cases:
 *  - Close on Diwali / Dec 25
 *  - Open a normally-closed day for a one-off
 *  - Different hours on a specific date
 */
@Entity('availability_overrides')
@Unique(['cook_id', 'date'])
export class AvailabilityOverride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  cook_id: string;

  @ManyToOne(() => Cook, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cook_id' })
  cook: Cook;

  /** YYYY-MM-DD in IST */
  @Column({ type: 'date' })
  @Index()
  date: string;

  @Column({ type: 'boolean', default: false })
  closed: boolean;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  windows: { start: string; end: string }[];

  @Column({ type: 'text', nullable: true })
  note: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
