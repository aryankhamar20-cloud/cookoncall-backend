-- ═══════════════════════════════════════════════════════════════════════════
-- P1.6 — Service Area model (Apr 27, 2026)
-- Run on Supabase SQL Editor or psql.
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. service_areas table (admin-curated master list) ───────────────────
CREATE TABLE IF NOT EXISTS service_areas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(50)  UNIQUE NOT NULL,
  name        VARCHAR(100)        NOT NULL,
  region      VARCHAR(50)         NOT NULL, -- 'west' | 'central' | 'north' | 'east' | 'south'
  city        VARCHAR(50)         NOT NULL DEFAULT 'Ahmedabad',
  is_active   BOOLEAN             NOT NULL DEFAULT TRUE,
  sort_order  INT                 NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_areas_active
  ON service_areas(is_active, city, sort_order);

-- ─── 2. area_requests table (hybrid "Other" → admin approves) ─────────────
CREATE TABLE IF NOT EXISTS area_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_role  VARCHAR(20) NOT NULL, -- 'cook' | 'customer'
  name            VARCHAR(100) NOT NULL,
  city            VARCHAR(50)  NOT NULL DEFAULT 'Ahmedabad',
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  approved_slug   VARCHAR(50), -- set when admin approves and creates the area
  reject_reason   TEXT,
  reviewed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_area_requests_status
  ON area_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_area_requests_requester
  ON area_requests(requester_id);

-- ─── 3. Cook columns: service_area_slugs + serves_all_city + per-area fees ─
-- service_area_fees stores: {"bodakdev": 49, "thaltej": 79, ...}
-- Default fee is 49 if a slug is in service_area_slugs but not in fees JSONB.
ALTER TABLE cooks
  ADD COLUMN IF NOT EXISTS service_area_slugs TEXT[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS serves_all_city    BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS service_area_fees  JSONB    NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_cooks_service_area_slugs
  ON cooks USING GIN (service_area_slugs);

-- ─── 4. Address column: area_slug (links to service_areas) ─────────────────
ALTER TABLE addresses
  ADD COLUMN IF NOT EXISTS area_slug VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_addresses_area_slug
  ON addresses(area_slug);

-- ─── 5. Booking column: area_slug (snapshot at booking time) ───────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS customer_area_slug VARCHAR(50);

-- ─── 6. Seed Ahmedabad areas ──────────────────────────────────────────────
-- ON CONFLICT (slug) DO NOTHING so re-running this migration won't duplicate.
INSERT INTO service_areas (slug, name, region, sort_order) VALUES
  -- West Ahmedabad (premium / target market)
  ('bodakdev',     'Bodakdev',     'west', 10),
  ('thaltej',      'Thaltej',      'west', 11),
  ('vastrapur',    'Vastrapur',    'west', 12),
  ('satellite',    'Satellite',    'west', 13),
  ('bopal',        'Bopal',        'west', 14),
  ('south-bopal',  'South Bopal',  'west', 15),
  ('shela',        'Shela',        'west', 16),
  ('ambli',        'Ambli',        'west', 17),
  ('sg-highway',   'SG Highway',   'west', 18),
  ('prahlad-nagar','Prahlad Nagar','west', 19),
  ('jodhpur',      'Jodhpur',      'west', 20),
  ('vejalpur',     'Vejalpur',     'west', 21),
  ('ghuma',        'Ghuma',        'west', 22),
  -- Central
  ('navrangpura',  'Navrangpura',  'central', 30),
  ('naranpura',    'Naranpura',    'central', 31),
  ('paldi',        'Paldi',        'central', 32),
  ('ellisbridge',  'Ellisbridge',  'central', 33),
  ('ashram-road',  'Ashram Road',  'central', 34),
  ('cg-road',      'C.G. Road',    'central', 35),
  ('ambawadi',     'Ambawadi',     'central', 36),
  -- North / Northwest
  ('chandkheda',   'Chandkheda',   'north', 40),
  ('motera',       'Motera',       'north', 41),
  ('sabarmati',    'Sabarmati',    'north', 42),
  ('ranip',        'Ranip',        'north', 43),
  ('gota',         'Gota',         'north', 44),
  ('sola',         'Sola',         'north', 45),
  -- East / Southeast
  ('maninagar',    'Maninagar',    'east', 50),
  ('ghatlodia',    'Ghatlodia',    'east', 51),
  ('naroda',       'Naroda',       'east', 52),
  ('nikol',        'Nikol',        'east', 53),
  ('vastral',      'Vastral',      'east', 54)
ON CONFLICT (slug) DO NOTHING;

-- ─── 7. Migration of existing chefs ────────────────────────────────────────
-- Per launch decision: existing chefs (Aayushi + any others) start with NO areas.
-- They MUST log in and pick areas before they show up in customer search again.
-- This is safe because the new service_area_slugs column already defaults to '{}'.
-- No UPDATE needed — DEFAULT '{}' handles it for existing rows.

-- ─── 8. Verify ─────────────────────────────────────────────────────────────
-- Run this manually after migration to verify:
-- SELECT count(*) AS area_count FROM service_areas WHERE is_active = TRUE;
-- Expected: 31
-- SELECT count(*) AS chefs_invisible FROM cooks WHERE service_area_slugs = '{}' AND serves_all_city = FALSE;
-- Expected: equal to total verified cook count
