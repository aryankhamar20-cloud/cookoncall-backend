import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Booking disputes / issue resolution (Phase D).
 *
 * Creates the `disputes` table: one row per issue raised on a booking by
 * the customer or chef, with admin resolution + optional recorded refund.
 * Matches src/modules/disputes/dispute.entity.ts.
 */
export class AddDisputes1755800000000 implements MigrationInterface {
  name = 'AddDisputes1755800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "disputes_status_enum" AS ENUM ('open','under_review','resolved','rejected');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "disputes_party_enum" AS ENUM ('customer','cook');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "disputes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "booking_id" uuid NOT NULL,
        "raised_by_user_id" uuid NOT NULL,
        "raised_by_role" "disputes_party_enum" NOT NULL,
        "reason" varchar(40) NOT NULL,
        "description" text NOT NULL,
        "status" "disputes_status_enum" NOT NULL DEFAULT 'open',
        "resolution_note" text,
        "refund_amount" numeric(10,2),
        "resolved_by" uuid,
        "resolved_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_disputes" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_disputes_booking_id" ON "disputes" ("booking_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_disputes_raised_by" ON "disputes" ("raised_by_user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_disputes_status" ON "disputes" ("status")`);
    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD CONSTRAINT "FK_disputes_booking" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD CONSTRAINT "FK_disputes_user" FOREIGN KEY ("raised_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "disputes"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "disputes_party_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "disputes_status_enum"`);
  }
}
