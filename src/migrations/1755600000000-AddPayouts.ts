import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chef payout settlement ledger (manual, Phase 1).
 *
 * Creates the `payouts` table: one row per money transfer an admin makes
 * to a chef, with status + method + reference so each chef's outstanding
 * balance is auditable (earned − SUM(paid)). Forward-compatible with
 * Razorpay Route (method='razorpay', reference=transfer id) in Phase 2.
 *
 * Matches src/modules/payouts/payout.entity.ts. In dev (synchronize:true)
 * the table is auto-created; this migration ships the same schema to
 * production (migrationsRun).
 */
export class AddPayouts1755600000000 implements MigrationInterface {
  name = 'AddPayouts1755600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "payouts_status_enum" AS ENUM ('pending','processing','paid','failed');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "payouts_method_enum" AS ENUM ('upi','bank_transfer','cash','razorpay','other');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payouts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "cook_id" uuid NOT NULL,
        "amount" numeric(10,2) NOT NULL,
        "status" "payouts_status_enum" NOT NULL DEFAULT 'pending',
        "method" "payouts_method_enum",
        "reference" varchar,
        "notes" text,
        "booking_count" integer NOT NULL DEFAULT 0,
        "period_start" TIMESTAMPTZ,
        "period_end" TIMESTAMPTZ,
        "created_by" uuid,
        "paid_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payouts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payouts_cook_id" ON "payouts" ("cook_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payouts_status" ON "payouts" ("status")
    `);
    await queryRunner.query(`
      ALTER TABLE "payouts"
        ADD CONSTRAINT "FK_payouts_cook"
        FOREIGN KEY ("cook_id") REFERENCES "cooks"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payouts"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payouts_method_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payouts_status_enum"`);
  }
}
