-- ═══════════════════════════════════════════════════════════════
-- CookOnCall — Analytics Phase 1
-- Date: 2026-05-28
-- Run in: Supabase → SQL Editor
--
-- Two append-only tables that power the admin analytics dashboard:
--
--   1. analytics_events           — raw event log (page views, signups,
--                                   bookings, payments, etc.)
--                                   Append-only, partitioned by month
--                                   for easy archival once data ages.
--
--   2. analytics_daily_metrics    — pre-computed daily roll-ups so the
--                                   dashboard never scans the raw event
--                                   log at query time. Refreshed by a
--                                   cron (analytics-aggregator.service)
--                                   every hour.
-- ═══════════════════════════════════════════════════════════════

-- ─── Raw event log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_events (
  id              BIGSERIAL PRIMARY KEY,
  event_type      VARCHAR(64) NOT NULL,
  user_id         UUID,                         -- nullable: anonymous events allowed
  user_role       VARCHAR(20),                  -- 'user' | 'cook' | 'admin' | NULL
  session_id      VARCHAR(64),                  -- client-generated session
  page_path       VARCHAR(255),                 -- e.g. /chef/abc123 or app-screen ID
  referrer        VARCHAR(255),
  metadata        JSONB,                        -- flexible: { booking_id, amount, source, ... }
  ip_address      VARCHAR(45),
  user_agent      TEXT,
  city            VARCHAR(64),
  device_type     VARCHAR(20),                  -- 'mobile' | 'desktop' | 'tablet' | 'app'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot indexes for the aggregator + ad-hoc admin queries.
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created
  ON analytics_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_user_created
  ON analytics_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analytics_events_created
  ON analytics_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_session
  ON analytics_events (session_id, created_at)
  WHERE session_id IS NOT NULL;

-- ─── Daily roll-ups ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_daily_metrics (
  id              BIGSERIAL PRIMARY KEY,
  metric_date     DATE NOT NULL,
  metric_type     VARCHAR(64) NOT NULL,         -- 'dau' | 'mau' | 'new_users' | 'bookings_total' | ...
  dimension_key   VARCHAR(64),                  -- optional: 'city' | 'cuisine' | 'role' | NULL
  dimension_value VARCHAR(128),                 -- e.g. 'Ahmedabad' or 'gujarati'
  value_int       BIGINT DEFAULT 0,
  value_decimal   DECIMAL(14,2) DEFAULT 0,
  metadata        JSONB,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One row per (date, metric, dimension) — upsert-friendly.
  UNIQUE (metric_date, metric_type, dimension_key, dimension_value)
);

CREATE INDEX IF NOT EXISTS idx_metrics_date_type
  ON analytics_daily_metrics (metric_date DESC, metric_type);

CREATE INDEX IF NOT EXISTS idx_metrics_type_date
  ON analytics_daily_metrics (metric_type, metric_date DESC);

ANALYZE analytics_events;
ANALYZE analytics_daily_metrics;

-- ─── Verification ─────────────────────────────────────────────
SELECT 'analytics_events' AS table_name, COUNT(*) FROM analytics_events
UNION ALL
SELECT 'analytics_daily_metrics', COUNT(*) FROM analytics_daily_metrics;
