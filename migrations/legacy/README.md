# Legacy raw-SQL migrations

These files were applied **manually** to production via `psql` before the
TypeORM-managed migration system landed (see `MIGRATIONS.md` at repo root).

They are **historical record** — already applied to every live database —
and exist here for archaeology only. Do not run them again, do not
reference them from new code.

## Order of application (chronological)

| File | Date | What it shipped |
|---|---|---|
| `2026-04-27_p16_service_areas.sql` | 2026-04-27 | P1.6 — chef service areas + per-area fees |
| `2026_05_28_round1_indexes.sql` | 2026-05-28 | Hot-path indexes (chefs, bookings, payments) |
| `2026_05_28_round2_security.sql` | 2026-05-28 | Constraint hardening, FK on-delete cascades |
| `2026_05_28_round3_broadcasts.sql` | 2026-05-28 | Admin broadcast feature schema |
| `2026_05_28_round4_notification_prefs.sql` | 2026-05-28 | Per-channel notification prefs on `users` |
| `2026_05_28_round4_analytics_phase2.sql` | 2026-05-28 | Analytics phase-2 daily rollups |
| `2026_05_28_p2_features.sql` | 2026-05-28 | Bookings flow round-2 (start/end OTP, reminders) |
| `2026_05_28_analytics_phase1.sql` | 2026-05-28 | Analytics events ingestion table |

## Why we don't auto-replay them

The `up()` / `down()` semantics of TypeORM migrations are not safe to
retrofit onto already-applied raw SQL — running these against a prod DB
where the tables already exist would either error on `CREATE TABLE`
or silently no-op via `IF NOT EXISTS`, neither of which gives a
trustworthy baseline.

Instead, the new TypeORM migration table (`migrations`) is bootstrapped
fresh from the **post-legacy** state of the schema (see
`src/migrations/1747000000000-Baseline.ts` — an empty marker that
declares "TypeORM-managed tracking starts from here").

## Adding a new schema change

**Don't** add another file to this directory. Use the new flow documented
in `/MIGRATIONS.md`:

```bash
# 1. Edit the entity under src/modules/.../*.entity.ts
# 2. Generate a real migration:
npm run migration:generate -- src/migrations/<descriptive-name>
# 3. Review the generated up()/down(), commit it.
# 4. On the next Railway deploy, migrationsRun:true auto-applies it.
```
