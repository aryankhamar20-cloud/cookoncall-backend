import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dietary tags + allergens on menu items (Phase D — Trust & Safety).
 *
 * Adds `dietary_tags` and `allergens` (jsonb string arrays) to menu_items
 * so dishes can be labelled (vegan/jain/halal/gluten-free…) and their
 * allergens surfaced to customers. Matches src/modules/cooks/menu-item.entity.ts.
 */
export class AddDietaryTags1755900000000 implements MigrationInterface {
  name = 'AddDietaryTags1755900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "dietary_tags" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "allergens" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "allergens"`);
    await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "dietary_tags"`);
  }
}
