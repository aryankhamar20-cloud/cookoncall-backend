-- ═══════════════════════════════════════════════════════════════
-- CookOnCall — Round 3 — admin broadcast push log
-- Date: 2026-05-28
-- Run in: Supabase → SQL Editor
--
-- Adds the `notification_broadcasts` table that records every admin
-- push broadcast (POST /admin/notifications/broadcast) along with the
-- delivery counters returned by FCM, so the admin UI can show
-- "last 50 broadcasts" with sent/targeted/with-token columns.
-- ═══════════════════════════════════════════════════════════════

-- 1. Audience enum -----------------------------------------------------
DO $$ BEGIN
  CREATE TYPE notification_broadcast_audience AS ENUM (
    'all', 'customers', 'cooks', 'area'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Table -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_broadcasts (
  id                     UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  title                  VARCHAR(120)    NOT NULL,
  body                   TEXT            NOT NULL,
  audience               notification_broadcast_audience NOT NULL,
  area_slug              VARCHAR(64),
  deep_link              VARCHAR(255),
  sent_by_admin_id       UUID,
  sent_by_admin_name     VARCHAR(100),
  recipients_targeted    INT             NOT NULL DEFAULT 0,
  recipients_with_token  INT             NOT NULL DEFAULT 0,
  fcm_dispatched         BOOLEAN         NOT NULL DEFAULT FALSE,
  inapp_created          INT             NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- 3. Newest-first index for the admin list view -----------------------
CREATE INDEX IF NOT EXISTS idx_notification_broadcasts_created
  ON notification_broadcasts (created_at DESC);

-- Verification: the new table should appear here.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'notification_broadcasts';
