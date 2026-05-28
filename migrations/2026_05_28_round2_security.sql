-- ═══════════════════════════════════════════════════════════════
-- CookOnCall — Round 2 Security & Integrity
-- Date: 2026-05-28
-- Run in: Supabase → SQL Editor
--
-- Adds idempotency_key column on the notifications table so the
-- create() service method can dedupe retries from Bull / webhooks /
-- crons. Without this column the column reference in the entity
-- silently fails on save (synchronize is off in production).
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);

-- Composite index supports the dedupe lookup
-- "find existing row for (user_id, idempotency_key)".
CREATE INDEX IF NOT EXISTS idx_notifications_user_idem
  ON notifications (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ANALYZE notifications;

-- Verification: should return 1 row showing the column exists
SELECT column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_name = 'notifications' AND column_name = 'idempotency_key';
