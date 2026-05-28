-- ============================================================
-- Migration: P2 Features — FCM token, Promo codes, Referrals
-- Date: 2026-05-28
-- Run ONCE on production database
-- ============================================================

-- ─── 1. FCM token for push notifications ─────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token VARCHAR(500) NULL;

-- ─── 2. Promo codes table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(30) UNIQUE NOT NULL,
  type          VARCHAR(10) NOT NULL CHECK (type IN ('flat', 'percent')),
  value         DECIMAL(8,2) NOT NULL,
  min_order     DECIMAL(8,2) NOT NULL DEFAULT 0,
  max_discount  DECIMAL(8,2) NULL,
  max_uses      INT NULL,
  max_uses_per_user INT NULL DEFAULT 1,
  used_count    INT NOT NULL DEFAULT 0,
  valid_from    TIMESTAMPTZ NOT NULL,
  valid_until   TIMESTAMPTZ NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  first_booking_only BOOLEAN NOT NULL DEFAULT false,
  description   TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active, valid_until);

-- ─── 3. Promo code usages table ──────────────────────────────
CREATE TABLE IF NOT EXISTS promo_code_usages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id  UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id     UUID NULL,
  discount_amount DECIMAL(8,2) NOT NULL,
  used_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_usages_code_user ON promo_code_usages(promo_code_id, user_id);
CREATE INDEX IF NOT EXISTS idx_promo_usages_user ON promo_code_usages(user_id);

-- ─── 4. Referrals table ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id           UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code                  VARCHAR(10) NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'completed', 'expired')),
  reward_amount         DECIMAL(8,2) NOT NULL DEFAULT 100,
  credited_at           TIMESTAMPTZ NULL,
  qualifying_booking_id UUID NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- ─── 5. Updated_at trigger for promo_codes ───────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_promo_codes_updated_at ON promo_codes;
CREATE TRIGGER update_promo_codes_updated_at
  BEFORE UPDATE ON promo_codes
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
