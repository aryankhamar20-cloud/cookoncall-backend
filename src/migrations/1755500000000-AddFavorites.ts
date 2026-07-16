import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P5.3 — customer "saved chefs" (favorites).
 *
 * Creates the `favorites` table: one row per (user, cook) pair, unique so
 * toggling is idempotent, with cascade deletes when either side is removed.
 * Matches the entity in src/modules/favorites/favorite.entity.ts.
 *
 * In dev (synchronize:true) the table is auto-created; this migration is
 * what ships the same schema to production (migrationsRun).
 */
export class AddFavorites1755500000000 implements MigrationInterface {
  name = 'AddFavorites1755500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "favorites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "cook_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_favorites" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_favorites_user_cook"
        ON "favorites" ("user_id", "cook_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "favorites"
        ADD CONSTRAINT "FK_favorites_user"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "favorites"
        ADD CONSTRAINT "FK_favorites_cook"
        FOREIGN KEY ("cook_id") REFERENCES "cooks"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "favorites"`);
  }
}
