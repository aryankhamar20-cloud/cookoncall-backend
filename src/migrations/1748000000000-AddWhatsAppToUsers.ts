import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `whatsapp_enabled` to the users table.
 *
 *   whatsapp_enabled  boolean  NOT NULL  DEFAULT true
 *
 * Mirrors the existing channel-pref columns (`email_enabled`,
 * `sms_enabled`, `push_enabled`) — same shape, same default. The
 * notifications service reads this flag via `_channelAllowed` before
 * queueing a WhatsApp send.
 *
 * Why default true:
 *   Every other transactional channel defaults to ON; new users
 *   expect to be told when their booking is confirmed without first
 *   visiting Settings. Users opt out from Settings (Phase 5 UI).
 *
 * Backfill:
 *   None required. The DEFAULT clause covers every existing row in
 *   one statement (Postgres rewrites at ALTER TABLE time when the
 *   default is constant — no full table scan, no transaction-bloat
 *   risk on the production users table).
 *
 * Compatibility with the entity:
 *   `User.whatsapp_enabled` is `@Column({ default: true })` boolean.
 *   The TypeORM strict-NULL contract only complains when reflection
 *   yields `Object` for the column type — `boolean` reflects as
 *   `Boolean`, which the postgres driver maps without issue. The
 *   entity-metadata smoke test in src/config/entity-metadata.spec.ts
 *   would catch a regression before merge.
 */
export class AddWhatsAppToUsers1748000000000 implements MigrationInterface {
  name = 'AddWhatsAppToUsers1748000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "users"
        ADD COLUMN "whatsapp_enabled" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "whatsapp_enabled"
    `);
  }
}
