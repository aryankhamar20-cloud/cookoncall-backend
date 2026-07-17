import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wallet ledger (makes referral rewards real).
 *
 * Creates `wallet_transactions`: signed credits/debits against a user's
 * balance (balance = SUM(amount)). Referral rewards, refund credits, and
 * pay-with-wallet all flow through here. Matches
 * src/modules/wallet/wallet-transaction.entity.ts. Idempotent.
 */
export class AddWallet1756100000000 implements MigrationInterface {
  name = 'AddWallet1756100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "wallet_transactions_type_enum" AS ENUM
          ('referral_reward','referee_discount','refund_credit','booking_payment','adjustment');
      EXCEPTION WHEN duplicate_object THEN null; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "wallet_transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "amount" numeric(10,2) NOT NULL,
        "balance_after" numeric(10,2) NOT NULL DEFAULT 0,
        "type" "wallet_transactions_type_enum" NOT NULL,
        "reference_type" varchar(20),
        "reference_id" uuid,
        "description" varchar(200),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_transactions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_wallet_transactions_user" ON "wallet_transactions" ("user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "wallet_transactions"
        ADD CONSTRAINT "FK_wallet_transactions_user"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_transactions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "wallet_transactions_type_enum"`);
  }
}
