import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Performance: index the hot foreign-key / filter columns.
 *
 * Postgres does NOT create indexes on foreign-key columns automatically
 * (only on PRIMARY KEY and UNIQUE constraints). The core tables —
 * bookings, payments, cooks, notifications, reviews — were created by
 * the legacy raw-SQL files and carry no index declarations in their
 * entities, so the hottest lookups in the app (a customer's bookings, a
 * chef's bookings, the notification bell, a chef's reviews, payment
 * lookup by booking) risk sequential scans that get linearly slower as
 * the tables grow.
 *
 * Each index is created only if no index already leads with that column,
 * so if a legacy SQL file already added one under a different name we
 * don't create a redundant duplicate. Composite indexes are ordered
 * (filter_column, created_at) to serve "list mine, newest first" which
 * is how these are actually queried.
 */
export class AddHotPathIndexes1756300000000 implements MigrationInterface {
  name = 'AddHotPathIndexes1756300000000';

  private async ensureIndex(
    q: QueryRunner,
    table: string,
    leadingCol: string,
    indexName: string,
    columnsSql: string,
  ): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = '${table}'
            AND indexdef ILIKE '%(${leadingCol}%'
        ) THEN
          EXECUTE 'CREATE INDEX ${indexName} ON "${table}" (${columnsSql})';
        END IF;
      END $$;
    `);
  }

  public async up(q: QueryRunner): Promise<void> {
    // A customer's bookings, newest first.
    await this.ensureIndex(q, 'bookings', 'user_id', 'idx_bookings_user_created', '"user_id", "created_at"');
    // A chef's bookings, newest first.
    await this.ensureIndex(q, 'bookings', 'cook_id', 'idx_bookings_cook_created', '"cook_id", "created_at"');
    // Admin filters + scheduler sweeps by status.
    await this.ensureIndex(q, 'bookings', 'status', 'idx_bookings_status', '"status"');
    // Reminder / upcoming-session jobs scan by scheduled time.
    await this.ensureIndex(q, 'bookings', 'scheduled_at', 'idx_bookings_scheduled_at', '"scheduled_at"');
    // Payment lookup by booking (every verify / receipt / wallet pay).
    await this.ensureIndex(q, 'payments', 'booking_id', 'idx_payments_booking_id', '"booking_id"');
    // Razorpay webhook resolves the payment by order id.
    await this.ensureIndex(q, 'payments', 'razorpay_order_id', 'idx_payments_rzp_order', '"razorpay_order_id"');
    // cooks.user_id resolves the chef profile on every chef request.
    await this.ensureIndex(q, 'cooks', 'user_id', 'idx_cooks_user_id', '"user_id"');
    // Notification bell: a user's notifications, newest first.
    await this.ensureIndex(q, 'notifications', 'user_id', 'idx_notifications_user_created', '"user_id", "created_at"');
    // Reviews shown on a chef profile.
    await this.ensureIndex(q, 'reviews', 'cook_id', 'idx_reviews_cook_id', '"cook_id"');
    // Google OAuth resolves an account by google_id.
    await this.ensureIndex(q, 'users', 'google_id', 'idx_users_google_id', '"google_id"');
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const name of [
      'idx_bookings_user_created',
      'idx_bookings_cook_created',
      'idx_bookings_status',
      'idx_bookings_scheduled_at',
      'idx_payments_booking_id',
      'idx_payments_rzp_order',
      'idx_cooks_user_id',
      'idx_notifications_user_created',
      'idx_reviews_cook_id',
      'idx_users_google_id',
    ]) {
      await q.query(`DROP INDEX IF EXISTS "${name}"`);
    }
  }
}
