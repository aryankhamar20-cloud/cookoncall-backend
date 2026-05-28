-- ═══════════════════════════════════════════════════════════════════════════
-- CookOnCall — P2 Feature Migration
-- Date: 2026-05-28
-- Run against: Supabase PostgreSQL
-- Instructions: Paste into Supabase SQL Editor and run
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Add FCM token column to users table ──────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;

-- ─── 2. Promo codes table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              VARCHAR(20) UNIQUE NOT NULL,
  type              VARCHAR(20) NOT NULL CHECK (type IN ('percentage', 'flat', 'free_visit')),
  value             DECIMAL(10, 2) NOT NULL DEFAULT 0,
  max_discount      DECIMAL(10, 2),
  min_order_amount  DECIMAL(10, 2) NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  single_use        BOOLEAN NOT NULL DEFAULT FALSE,
  max_uses          INTEGER,
  used_count        INTEGER NOT NULL DEFAULT 0,
  expires_at        TIMESTAMPTZ,
  description       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 3. Promo code usages table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_code_usages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id     UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id        UUID,
  discount_applied  DECIMAL(10, 2) NOT NULL,
  used_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (promo_code_id, user_id)  -- one use per user for single_use promos
);

-- ─── 4. Referrals table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status               VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rewarded')),
  referrer_reward      DECIMAL(10, 2) NOT NULL DEFAULT 0,
  referee_reward       DECIMAL(10, 2) NOT NULL DEFAULT 0,
  rewarded_booking_id  UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (referred_user_id)  -- a user can only be referred once
);

-- ─── 5. Indexes for performance ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_promo_codes_code       ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_is_active  ON promo_codes(is_active);
CREATE INDEX IF NOT EXISTS idx_promo_usages_user      ON promo_code_usages(user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer     ON referrals(referrer_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred     ON referrals(referred_user_id);

-- ─── 6. Seed a welcome promo code ────────────────────────────────────────
INSERT INTO promo_codes (code, type, value, max_discount, min_order_amount, single_use, max_uses, description)
VALUES ('WELCOME50', 'flat', 50, NULL, 199, true, 1000, 'Welcome offer — ₹50 off your first booking')
ON CONFLICT (code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- Done! Verify with:
--   SELECT * FROM promo_codes;
--   \d users;  -- check fcm_token column
-- ═══════════════════════════════════════════════════════════════════════════
