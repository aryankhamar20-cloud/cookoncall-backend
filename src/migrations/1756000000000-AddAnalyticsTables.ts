import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Analytics tables — PRODUCTION FIX.
 *
 * `analytics_events` and `analytics_daily_metrics` were only ever created
 * by dev `synchronize:true` (the entity comment references a legacy SQL
 * file that doesn't exist in the repo). In production (synchronize:false)
 * they were never created, so every admin analytics query that touches
 * `analytics_events` (overview DAU, users device-breakdown) threw
 * `relation "analytics_events" does not exist` → HTTP 500, and the admin
 * dashboard showed "Some metrics couldn't load".
 *
 * This migration ships those tables to prod. Idempotent (IF NOT EXISTS),
 * so it's a no-op in any environment that already has them. Schema matches
 * src/modules/analytics/entities/*.entity.ts exactly.
 */
export class AddAnalyticsTables1756000000000 implements MigrationInterface {
  name = 'AddAnalyticsTables1756000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── analytics_events (append-only event log) ───
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "analytics_events" (
        "id" BIGSERIAL NOT NULL,
        "event_type" varchar(64) NOT NULL,
        "user_id" uuid,
        "user_role" varchar(20),
        "session_id" varchar(64),
        "page_path" varchar(255),
        "referrer" varchar(255),
        "metadata" jsonb,
        "ip_address" varchar(45),
        "user_agent" text,
        "city" varchar(64),
        "device_type" varchar(20),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_analytics_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_analytics_events_type_created" ON "analytics_events" ("event_type", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_analytics_events_user_created" ON "analytics_events" ("user_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_analytics_events_created" ON "analytics_events" ("created_at")`,
    );

    // ─── analytics_daily_metrics (pre-aggregated rollups) ───
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "analytics_daily_metrics" (
        "id" BIGSERIAL NOT NULL,
        "metric_date" date NOT NULL,
        "metric_type" varchar(64) NOT NULL,
        "dimension_key" varchar(64),
        "dimension_value" varchar(128),
        "value_int" bigint NOT NULL DEFAULT 0,
        "value_decimal" numeric(14,2) NOT NULL DEFAULT 0,
        "metadata" jsonb,
        "computed_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_analytics_daily_metrics" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_metrics_date_type_dim"
        ON "analytics_daily_metrics" ("metric_date", "metric_type", "dimension_key", "dimension_value")
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_metrics_date_type" ON "analytics_daily_metrics" ("metric_date", "metric_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_metrics_type_date" ON "analytics_daily_metrics" ("metric_type", "metric_date")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "analytics_daily_metrics"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "analytics_events"`);
  }
}
