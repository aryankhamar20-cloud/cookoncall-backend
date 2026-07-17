import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recurring meal-plan subscriptions (Phase C).
 *
 * Creates `subscriptions` (the recurring plan) and `subscription_runs`
 * (each materialized session → booking). Matches
 * src/modules/subscriptions/*.entity.ts. Dev auto-syncs; this ships the
 * same schema to prod via migrationsRun.
 */
export class AddSubscriptions1755700000000 implements MigrationInterface {
  name = 'AddSubscriptions1755700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "subscriptions_cadence_enum" AS ENUM ('weekly','biweekly','monthly');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "subscriptions_status_enum" AS ENUM ('active','paused','cancelled');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "subscription_runs_status_enum" AS ENUM ('scheduled','skipped','fulfilled','cancelled');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "subscriptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "cook_id" uuid NOT NULL,
        "meal_package_id" uuid,
        "booking_template" jsonb NOT NULL DEFAULT '{}',
        "cadence" "subscriptions_cadence_enum" NOT NULL DEFAULT 'weekly',
        "days_of_week" jsonb NOT NULL DEFAULT '[]',
        "time_slot" varchar(5) NOT NULL DEFAULT '20:00',
        "address_id" uuid,
        "status" "subscriptions_status_enum" NOT NULL DEFAULT 'active',
        "price_per_session" numeric(10,2) NOT NULL DEFAULT 0,
        "next_run_at" TIMESTAMPTZ,
        "started_at" TIMESTAMPTZ,
        "ends_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subscriptions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_subscriptions_user_id" ON "subscriptions" ("user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_subscriptions_cook_id" ON "subscriptions" ("cook_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_subscriptions_next_run_at" ON "subscriptions" ("next_run_at")`);
    await queryRunner.query(`
      ALTER TABLE "subscriptions"
        ADD CONSTRAINT "FK_subscriptions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "subscriptions"
        ADD CONSTRAINT "FK_subscriptions_cook" FOREIGN KEY ("cook_id") REFERENCES "cooks"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "subscription_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subscription_id" uuid NOT NULL,
        "booking_id" uuid,
        "scheduled_for" TIMESTAMPTZ NOT NULL,
        "status" "subscription_runs_status_enum" NOT NULL DEFAULT 'scheduled',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subscription_runs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_subscription_runs_subscription_id" ON "subscription_runs" ("subscription_id")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_subscription_runs_sub_slot"
        ON "subscription_runs" ("subscription_id", "scheduled_for")
    `);
    await queryRunner.query(`
      ALTER TABLE "subscription_runs"
        ADD CONSTRAINT "FK_subscription_runs_subscription" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "subscription_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "subscriptions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "subscription_runs_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "subscriptions_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "subscriptions_cadence_enum"`);
  }
}
