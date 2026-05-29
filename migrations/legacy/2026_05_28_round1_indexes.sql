-- ═══════════════════════════════════════════════════════════════
-- CookOnCall — Round 1 Production Index Pack
-- Date: 2026-05-28
-- Run in: Supabase → SQL Editor (paste, click Run)
--
-- All statements use CREATE INDEX CONCURRENTLY so they DO NOT lock
-- the tables during creation. Safe to run during business hours.
--
-- Each `IF NOT EXISTS` guard makes this idempotent — re-running is a
-- no-op. ANALYZE at the bottom refreshes the planner stats so the
-- new indexes are actually used.
-- ═══════════════════════════════════════════════════════════════

-- ─── Bookings ─────────────────────────────────────────────────
-- Hot path: customer's bookings list (My Orders screen)
-- Ordered by created_at DESC so the index can drive the sort directly.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_user_status_created
  ON bookings (user_id, status, created_at DESC);

-- Hot path: cook's incoming bookings list
-- Partial index excludes already-finished states (covers ~70% of writes).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_cook_scheduled
  ON bookings (cook_id, scheduled_at)
  WHERE status NOT IN ('cancelled_by_user', 'cancelled_by_cook', 'expired', 'completed');

-- Scheduler hot path: cron job that expires lapsed pending / awaiting-payment
-- bookings. Partial index keeps it tiny — only contains live timers.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_status_payment_expires
  ON bookings (status, payment_expires_at)
  WHERE status IN ('pending_chef_approval', 'awaiting_payment');

-- ─── Cooks ─────────────────────────────────────────────────────
-- Customer chef discovery — the most expensive query in the app.
-- Composite + partial covers the common filter (available + verified)
-- and the sort (rating DESC).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cooks_search_composite
  ON cooks (is_available, is_verified, rating DESC)
  WHERE is_available = TRUE AND is_verified = TRUE;

-- Customer area-filter: GIN index on the service_area_slugs array column.
-- Required for `WHERE 'ahmedabad-vastrapur' = ANY(service_area_slugs)` to be fast.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cooks_area_slugs_gin
  ON cooks USING GIN (service_area_slugs);

-- ─── Notifications ────────────────────────────────────────────
-- Hot unread counter on every dashboard load.
-- Partial index keeps it tiny — only unread rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_unread
  ON notifications (user_id, created_at DESC)
  WHERE is_read = FALSE;

-- Notification feed (read + unread together)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

-- ─── Reviews ──────────────────────────────────────────────────
-- Chef profile load fetches recent reviews ordered by date.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_cook_recent
  ON reviews (cook_id, created_at DESC);

-- ─── Users ────────────────────────────────────────────────────
-- Case-insensitive email lookup on login (auth service does
-- LOWER(email) = LOWER($1) — without this, the planner does a seq scan).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_lower
  ON users (LOWER(email));

-- ─── Availability overrides ───────────────────────────────────
-- Cook's date overrides are looked up by date >= today.
-- Note: predicates with CURRENT_DATE are NOT immutable so they cannot
-- live in the WHERE clause of a CONCURRENTLY-created index. We use a
-- plain composite instead — still fast enough at our scale.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_availability_overrides_cook_date
  ON availability_overrides (cook_id, date);

-- ─── Refresh planner stats ─────────────────────────────────────
-- After creating new indexes you MUST analyze so the query planner
-- picks them up. Without this, queries may still use seq scans for
-- a few hours until autovacuum kicks in.
ANALYZE bookings;
ANALYZE cooks;
ANALYZE notifications;
ANALYZE reviews;
ANALYZE users;
ANALYZE availability_overrides;

-- ═══════════════════════════════════════════════════════════════
-- Verification — run these AFTER the indexes finish building to
-- confirm everything landed. Should return 9 rows.
-- ═══════════════════════════════════════════════════════════════
SELECT indexname, tablename
FROM pg_indexes
WHERE indexname IN (
  'idx_bookings_user_status_created',
  'idx_bookings_cook_scheduled',
  'idx_bookings_status_payment_expires',
  'idx_cooks_search_composite',
  'idx_cooks_area_slugs_gin',
  'idx_notifications_unread',
  'idx_notifications_user_created',
  'idx_reviews_cook_recent',
  'idx_users_email_lower',
  'idx_availability_overrides_cook_date'
)
ORDER BY tablename, indexname;
