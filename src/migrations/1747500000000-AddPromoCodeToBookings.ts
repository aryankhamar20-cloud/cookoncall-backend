import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add three columns to bookings to record promo-code redemptions.
 *
 *   promo_code_id        uuid          NULL   — FK-by-convention to promo_codes.id
 *   promo_code_snapshot  varchar(20)   NULL   — the code text, preserved if promo later deleted
 *   promo_discount       numeric(10,2) NULL   — ₹ amount subtracted from total_price
 *
 * No DB foreign key on promo_code_id by design — admin can delete a
 * promo (only when used_count=0 — see promo-codes.service `remove`),
 * but this protects against accidental cascades on historical bookings.
 *
 * No backfill required: existing rows get NULL for all three, which
 * exactly represents "this booking had no promo applied". The
 * @Column on the entity is `nullable: true` for all three, matching.
 *
 * Indexed on promo_code_id so the admin "list redemptions" query
 * stays fast as bookings volume grows. (The promo_code_usages table
 * is the primary index for that lookup; this is for the bookings-side
 * "find me all bookings that used promo X" query.)
 */
export class AddPromoCodeToBookings1747500000000
  implements MigrationInterface
{
  name = 'AddPromoCodeToBookings1747500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "bookings"
        ADD COLUMN "promo_code_id"       uuid                 NULL,
        ADD COLUMN "promo_code_snapshot" varchar(20)          NULL,
        ADD COLUMN "promo_discount"      numeric(10,2)        NULL
    `);
    await q.query(`
      CREATE INDEX "idx_bookings_promo_code_id"
        ON "bookings" ("promo_code_id")
        WHERE "promo_code_id" IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_bookings_promo_code_id"`);
    await q.query(`
      ALTER TABLE "bookings"
        DROP COLUMN IF EXISTS "promo_discount",
        DROP COLUMN IF EXISTS "promo_code_snapshot",
        DROP COLUMN IF EXISTS "promo_code_id"
    `);
  }
}
