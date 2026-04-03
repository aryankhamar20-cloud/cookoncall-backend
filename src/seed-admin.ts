/**
 * ADMIN SEED SCRIPT
 * Run once after first deployment to create admin user.
 *
 * Usage:
 *   npx ts-node src/seed-admin.ts
 *
 * Make sure your .env file has DATABASE_URL set.
 */

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

dotenv.config();

const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  entities: [],
  synchronize: false,
});

async function seed() {
  await AppDataSource.initialize();
  console.log('Connected to database');

  const email = 'admin@cookoncall.in';
  const password = process.env.ADMIN_PASSWORD || 'Admin@CookOnCall2025';
  const hashedPassword = await bcrypt.hash(password, 12);

  // Check if admin exists
  const existing = await AppDataSource.query(
    `SELECT id FROM users WHERE email = $1`,
    [email],
  );

  if (existing.length > 0) {
    console.log('Admin user already exists. Skipping.');
    await AppDataSource.destroy();
    return;
  }

  await AppDataSource.query(
    `INSERT INTO users (id, name, email, password, role, phone_verified, is_active, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, true, true, NOW(), NOW())`,
    ['Admin', email, hashedPassword, 'admin'],
  );

  console.log('✅ Admin user created!');
  console.log(`   Email:    ${email}`);
  console.log(`   Password: ${password}`);
  console.log('   ⚠️  CHANGE THIS PASSWORD IMMEDIATELY after first login!');

  await AppDataSource.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
