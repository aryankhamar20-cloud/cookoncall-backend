/**
 * ADMIN AUTO-SEED
 * Runs on every app startup. Idempotent: creates admin accounts if they don't
 * already exist, otherwise logs "already exists" and does nothing.
 *
 * To add/remove an admin: edit the ADMINS array, commit, push.
 * To rotate a password: delete the user row in Supabase, update below, push.
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
        `SELECT id, role, email_verified FROM users WHERE email = $1 LIMIT 1`,
        [email],
      );

      if (existing.length > 0) {
        const user = existing[0];
        const needsUpdate = user.role !== 'admin' || !user.email_verified;

        if (needsUpdate) {
          await dataSource.query(
            `UPDATE users
             SET role = 'admin',
                 is_active = true,
                 email_verified = true,
                 updated_at = NOW()
             WHERE id = $1`,
            [user.id],
          );
          logger.log(`Updated admin account (role + email_verified): ${email}`);
        } else {
          logger.log(`Admin already exists and is correct, skipping: ${email}`);
        }
        continue;
      }

      const hashedPassword = await bcrypt.hash(admin.password, 12);

      await dataSource.query(
        `INSERT INTO users
           (id, name, email, password, role, email_verified, phone_verified, is_active, created_at, updated_at)
         VALUES
           (gen_random_uuid(), $1, $2, $3, 'admin', true, true, true, NOW(), NOW())`,
        [admin.name, email, hashedPassword],
      );

      logger.log(`Created admin account: ${email}`);
    } catch (err) {
      logger.error(
        `Failed to seed admin ${email}: ${(err as Error).message}`,
      );
    }
  }
}
