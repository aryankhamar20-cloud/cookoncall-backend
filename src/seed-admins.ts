/**
 * ADMIN AUTO-SEED
 * Runs on every app startup. Idempotent: creates admin accounts if they
 * don't already exist (or fixes role/email_verified on existing rows),
 * otherwise does nothing.
 *
 * Configuration: set ADMIN_SEEDS to a JSON array of admin objects:
 *   ADMIN_SEEDS='[{"name":"Admin","email":"admin@example.com","password":"long-strong-password"}]'
 *
 * If ADMIN_SEEDS is unset or malformed, seeding is silently skipped and
 * existing admin accounts in the database are left untouched. This is
 * intentional: removing the env var is safe and never locks anyone out.
 *
 * Note: this seeder INSERTs new admins but does NOT overwrite the
 * password of an existing admin row. To rotate a password, use the
 * normal password-reset flow or update the row directly in the DB.
 */

import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Logger } from '@nestjs/common';

interface SeedAdmin {
  name: string;
  email: string;
  password: string;
}

function parseAdminSeeds(
  raw: string | undefined,
  logger: Logger,
): SeedAdmin[] {
  if (!raw || !raw.trim()) {
    logger.warn(
      'ADMIN_SEEDS not set — skipping admin auto-seed. ' +
        'To enable, set ADMIN_SEEDS to a JSON array of admin objects.',
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(
      `ADMIN_SEEDS is not valid JSON, skipping admin auto-seed: ${
        (err as Error).message
      }`,
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.error(
      'ADMIN_SEEDS must be a JSON array, skipping admin auto-seed',
    );
    return [];
  }

  const seeds: SeedAdmin[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as Record<string, unknown> | null;
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.name !== 'string' ||
      typeof entry.email !== 'string' ||
      typeof entry.password !== 'string' ||
      !entry.name.trim() ||
      !entry.email.trim() ||
      !entry.password.trim()
    ) {
      logger.error(
        `ADMIN_SEEDS[${i}] is missing required string fields (name, email, password) — skipping this entry`,
      );
      continue;
    }
    seeds.push({
      name: entry.name,
      email: entry.email,
      password: entry.password,
    });
  }
  return seeds;
}

export async function seedAdmins(dataSource: DataSource): Promise<void> {
  const logger = new Logger('SeedAdmins');
  const admins = parseAdminSeeds(process.env.ADMIN_SEEDS, logger);

  if (admins.length === 0) return;

  for (const admin of admins) {
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
          logger.log(
            `Updated admin account (role + email_verified): ${email}`,
          );
        } else {
          logger.log(
            `Admin already exists and is correct, skipping: ${email}`,
          );
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
