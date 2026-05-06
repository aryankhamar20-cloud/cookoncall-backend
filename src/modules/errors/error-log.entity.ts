import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('error_logs')
@Index('idx_error_logs_created_at', ['created_at'])
export class ErrorLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Short error message (e.g. "Cannot read properties of undefined")
  @Column({ type: 'text' })
  message: string;

  // Full stack trace from ErrorBoundary
  @Column({ type: 'text', nullable: true })
  stack: string | null;

  // Which React component threw the error (from componentStack)
  @Column({ type: 'text', nullable: true })
  component_stack: string | null;

  // URL where the error occurred (window.location.href)
  @Column({ type: 'text', nullable: true })
  url: string | null;

  // Optional: logged-in user ID (null for unauthenticated)
  @Column({ type: 'uuid', nullable: true })
  user_id: string | null;

  // Browser/device info (navigator.userAgent)
  @Column({ type: 'text', nullable: true })
  user_agent: string | null;

  @CreateDateColumn()
  created_at: Date;
}
