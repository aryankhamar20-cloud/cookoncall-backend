-- ═══════════════════════════════════════════════════════════════
-- CookOnCall — Round 4 — User notification channel preferences
-- Date: 2026-05-28
-- Run in: Supabase → SQL Editor
--
-- Adds three boolean flags to the `users` table so customers and
-- chefs can mute push, email, and SMS independently from the
-- Settings → Notifications screen.
--
-- Defaults are TRUE because for a transactional service the user
-- expects channel messages until they opt out. In-app notifications
-- are NEVER suppressed and have no flag here.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS push_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS sms_enabled   BOOLEAN NOT NULL DEFAULT TRUE;

-- Verification — should return three rows.
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'users'
  AND column_name IN ('push_enabled', 'email_enabled', 'sms_enabled')
ORDER BY column_name;
