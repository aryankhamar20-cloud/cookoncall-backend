-- ═══════════════════════════════════════════════════════════════
-- CookOnCall — Round 4 / Analytics Phase 2
-- Date: 2026-05-28
-- Run in: Supabase → SQL Editor
--
-- Adds notification click-through tracking so the admin Broadcast
-- panel can show CTR per blast.
--   • notifications.clicked_at  — set the first time the user opens
--     a notification. NULL means "never clicked".
--   • Partial index speeds up the CTR aggregate query so it's still
--     fast on hundreds of thousands of rows.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ;

-- Partial index covers the only WHERE clause that actually filters by
-- this column (CTR aggregation). Smaller and faster than a full index
-- since most rows are NULL early on.
CREATE INDEX IF NOT EXISTS idx_notifications_idem_clicked
  ON notifications (idempotency_key)
  WHERE clicked_at IS NOT NULL;

-- Verification — should return one row.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'notifications' AND column_name = 'clicked_at';
