-- One-time baseline stamp for the existing Supabase database.
--
-- The DB already contains bank_txs + config, so migration 0000_baseline (which CREATEs them)
-- must NOT run. This records 0000 as already-applied in drizzle's journal so that
-- `drizzle-kit migrate` skips it and applies only 0001_add_currency onward.
--
-- drizzle-kit migrate (node-postgres) gates by created_at: a migration runs only when its
-- journal timestamp exceeds the max created_at already recorded. Seeding 0000's timestamp
-- (1784044885098) here makes migrate skip 0000 and apply 0001.
--
-- Run ONCE against the DB before the first `drizzle-kit migrate`:
--   set -a; . ../../.env.local; set +a
--   psql "$DATABASE_URL" -f drizzle/stamp_baseline.sql
-- Idempotent: re-running is a no-op.

CREATE SCHEMA IF NOT EXISTS "drizzle";

CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
	id SERIAL PRIMARY KEY,
	hash text NOT NULL,
	created_at bigint
);

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
SELECT '364f066b3c2aa86351966c403f168486b1ead31d5f9b1b14e06121a6a809eaed', 1784044885098
WHERE NOT EXISTS (
	SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE created_at = 1784044885098
);
