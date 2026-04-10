/**
 * ADMIN AUTO-SEED
 * Runs on every app startup. Idempotent: creates admin accounts if they don't
 * already exist, otherwise logs "already exists" and does nothing.
 *
 * This is the ONLY safe way to create admin accounts in this codebase, because
 * the public /auth/register endpoint forces role to "user" or "cook" and
 * rejects any attempt to register as admin.
 *
 * To add, remove, or change an admin:
 *   1. Edit the ADMINS array below.
 *   2. Commit and push. Railway auto-deploys. On the next restart the new
 *      admin(s) are inserted. Existing admins are left untouched.
 *
 * To rotate a password:
 *   1. Delete the user row from Supabase, update the password below, commit,
 *      push. On the next restart the account is re-created with the new
 *      password. (Or build a proper "change password" endpoint later.)
 */

import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Logger } from '@nestjs/common';

interface SeedAdmin {
  name: string;
  email: string;
  password: string;
}

const ADMINS: SeedAdmin[] = [
  {
    name: 'Aryan',
    email: 'aryankhamar20@gmail.com',
    password: 'Imaryan@9979',
  },
  {
    name: 'Aayushi',
    email: 'aayushi.patel250506@gmail.com',
    password: 'Aayushi@25',
  },
];

export async function seedAdmins(dataSource: DataSource): Promise<void> {
  const logger = new Logger('SeedAdmins');

  for (const admin of ADMINS) {
    const email = admin.email.toLowerCase();

    try {
      const existing = await dataSource.query(
        `SELECT id, role FROM users WHERE email = $1 LIMIT 1`,
        [email],
      );

      if (existing.length > 0) {
        // If the account exists but somehow isn't admin, promote it.
        if (existing[0].role !== 'admin') {
          await dataSource.query(
            `UPDATE users SET role = 'admin', is_active = true, updated_at = NOW() WHERE id = $1`,
            [existing[0].id],
          );
          logger.log(`Promoted existing account to admin: ${email}`);
        } else {
          logger.log(`Admin already exists, skipping: ${email}`);
        }
        continue;
      }

      const hashedPassword = await bcrypt.hash(admin.password, 12);

      await dataSource.query(
        `INSERT INTO users
           (id, name, email, password, role, phone_verified, is_active, created_at, updated_at)
         VALUES
           (gen_random_uuid(), $1, $2, $3, 'admin', true, true, NOW(), NOW())`,
        [admin.name, email, hashedPassword],
      );

      logger.log(`Created admin account: ${email}`);
    } catch (err) {
      // Never crash the app because of a seed failure.
      logger.error(
        `Failed to seed admin ${email}: ${(err as Error).message}`,
      );
    }
  }
}
