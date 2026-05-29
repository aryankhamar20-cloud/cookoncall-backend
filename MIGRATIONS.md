# Database migrations

This document describes how schema changes flow from your laptop to
production. It replaces the previous "write a `.sql` file, `psql` it
manually" practice that produced the eight legacy files now archived
under `/migrations/legacy/`.

## TL;DR

| Environment | Schema source of truth | How it's applied |
|---|---|---|
| Local dev | `synchronize: true` | TypeORM auto-syncs entity → DB on app boot |
| Production | Migration files in `src/migrations/` | `migrationsRun: true` on app boot — Railway deploy applies pending migrations atomically with the new code |

## When you change an entity

```bash
# 1. Edit the entity under src/modules/.../*.entity.ts as usual.

# 2. Generate a migration. Pick a short kebab-case name describing the change.
npm run migration:generate -- src/migrations/add-promo-code-to-bookings

# 3. Review the generated file. TypeORM diffs the entity tree against
#    the live DATABASE_URL and emits CREATE/ALTER/DROP SQL. Verify
#    nothing destructive sneaked in (e.g. a column rename comes through
#    as DROP+ADD by default — adjust to ALTER COLUMN ... RENAME TO).

# 4. Commit both the entity change AND the migration file together.

# 5. On merge to main, Railway redeploys. migrationsRun:true applies
#    the new migration before the new code starts serving traffic.
```

## When you change reference data (seeds, lookups)

Same flow. Use `queryRunner.query('INSERT INTO ...')` inside `up()`
for one-shot data fixes. Idempotency is your responsibility — wrap
inserts in `ON CONFLICT DO NOTHING` where appropriate.

## First-time setup on prod (one-time only — read this if Railway is crashing on boot)

When this PR ships, prod's `migrations` table is empty but the schema
is already fully populated by the legacy raw SQL. The first deploy
with `migrationsRun: true` will see the empty `Baseline` migration
and try to run it — that's fine, it does nothing — but the row gets
recorded, so future migrations work normally.

If for any reason you need to seed the `migrations` table by hand
(e.g. you bypassed the baseline and are recovering), connect to the
prod DB and run:

```sql
INSERT INTO migrations (timestamp, name) VALUES
  (1747000000000, 'Baseline1747000000000');
```

This tells TypeORM "the baseline already ran" so it skips it on next
boot and proceeds to any newer migrations.

## Common operations

```bash
# See what's pending vs. applied (against DATABASE_URL)
npm run migration:show

# Apply pending migrations manually (e.g. to your local dev DB once
# you've turned synchronize off there)
npm run migration:run

# Roll back the most recent migration
npm run migration:revert
```

All of these read `DATABASE_URL` from `.env` (or the environment) via
`src/config/typeorm-cli.config.ts`.

## Reviewing a migration in a PR

The diff should answer:

1. **Is the operation reversible?** A column drop or table drop has
   no safe `down()` — call it out in the PR description and confirm
   we're OK rolling forward only.
2. **Is it idempotent on re-run?** Defensive `IF NOT EXISTS` /
   `IF EXISTS` clauses are cheap insurance for prod recovery scenarios.
3. **Does it lock?** A naive `ALTER TABLE` on a large prod table can
   take an exclusive lock for minutes. For tables we know are large
   (`bookings`, `notifications`, `analytics_events`), prefer concurrent
   index creation (`CREATE INDEX CONCURRENTLY`) and split DDL into
   multiple atomic migrations.
4. **Does it match the entity change?** TypeORM occasionally emits
   redundant `ALTER COLUMN type TO same-type` lines — drop them.

## Why dev still has `synchronize: true`

Cutting dev over to migrations-only adds friction (every entity tweak
now requires `migration:generate` before tests pass). The bigger risk
right now is **prod schema drift**, which is solved by `migrationsRun`
in prod regardless of what dev does.

Once we have ~3 real migrations through the new system and the team is
comfortable with the workflow, we'll flip dev to `synchronize: false`
too. That closes the last drift vector. See the `TODO(migrations)`
comment in `src/config/database.config.ts`.

## What about the legacy `.sql` files?

They're at `/migrations/legacy/` for archaeological reference only.
They have already been applied to every database that exists. Do
**not** edit them, run them, or reference them from new code. See
`/migrations/legacy/README.md` for their chronology.
