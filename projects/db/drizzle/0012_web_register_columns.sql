-- Hand-pruned from drizzle-kit's generated output.
--
-- `db:generate` emitted this migration conflated with the whole of 0010 (matcher_result) and 0011
-- (category_group timestamps), because meta/0010_snapshot.json and meta/0011_snapshot.json were
-- never written — so generate diffed schema.ts against the newest snapshot it could find, 0009, and
-- re-derived two already-applied migrations as new. Those statements are removed here; the live DB
-- has had them since __drizzle_migrations ids 11 and 12.
--
-- The accompanying meta/0012_snapshot.json is drizzle's own output and is kept verbatim: it
-- describes the full current schema.ts, which is exactly the shape the DB has once the three
-- statements below are applied. That also repairs the snapshot chain — the next `db:generate`
-- diffs against it and reports "No schema changes".
--
-- See the root CLAUDE.md ("hand-author the .sql and transform the previous meta/NNNN_snapshot.json")
-- and 0003_finalize_bank_tx for the established pattern.

ALTER TABLE "bank_account" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "bank_tx" ADD COLUMN "memo" text;--> statement-breakpoint
CREATE INDEX "bank_tx_date_id_idx" ON "bank_tx" USING btree ("date","id");
