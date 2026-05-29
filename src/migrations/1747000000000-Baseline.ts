import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline marker — TypeORM-managed migration tracking starts here.
 *
 * Why this is empty
 * -----------------
 * Production already has the full schema applied via the 8 legacy raw-SQL
 * files (see `migrations/legacy/README.md`). This migration represents
 * the cut-over point: from now on, every schema change goes through
 * `npm run migration:generate` and lands as a sibling of this file.
 *
 * On a fresh (post-legacy) database
 * ---------------------------------
 * Running this migration is a no-op. The schema is built either by
 * `synchronize: true` in dev, or — once we flip dev to migrations-only —
 * by replaying the generated migrations starting AFTER this one.
 *
 * On the live production database
 * -------------------------------
 * The user must seed the typeorm `migrations` table once, by inserting
 * a row that says "this baseline already ran":
 *
 *     INSERT INTO migrations (timestamp, name) VALUES
 *       (1747000000000, 'Baseline1747000000000');
 *
 * After that one-time seed, `migrationsRun: true` in `database.config.ts`
 * will see the baseline as already-applied and only run subsequent ones.
 * See `/MIGRATIONS.md` -> "First-time setup on prod" for the exact steps.
 *
 * Why the timestamp is 1747000000000
 * ----------------------------------
 * 1747000000000 = 2025-05-12 (UTC). Earlier than any future migration
 * `generate` would produce, so this always sorts first. The exact value
 * doesn't matter as long as it's smaller than every subsequent migration's
 * timestamp.
 */
export class Baseline1747000000000 implements MigrationInterface {
  name = 'Baseline1747000000000';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async up(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally empty. See class doc comment.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally empty. There is no inverse to "we existed".
  }
}
