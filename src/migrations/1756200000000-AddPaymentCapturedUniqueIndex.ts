import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforce at most ONE captured payment per booking.
 *
 * Defence-in-depth against a double-charge if two payment requests for
 * the same booking race (e.g. a double-tapped pay-from-wallet). The
 * application path already serializes with a per-booking advisory lock;
 * this partial unique index is the database-level backstop that makes a
 * second captured row impossible even if application logic regresses.
 *
 * Partial (WHERE status = 'captured') so historical CREATED / FAILED
 * attempts for a booking are still allowed — only the terminal
 * money-moving state is constrained.
 */
export class AddPaymentCapturedUniqueIndex1756200000000
  implements MigrationInterface
{
  name = 'AddPaymentCapturedUniqueIndex1756200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payments_booking_captured" ` +
        `ON "payments" ("booking_id") WHERE "status" = 'captured'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_payments_booking_captured"`,
    );
  }
}
