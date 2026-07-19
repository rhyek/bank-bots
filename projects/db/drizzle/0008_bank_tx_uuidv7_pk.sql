-- Hand-authored: drizzle-kit cannot model a primary-key type change.
-- Converts bank_tx.id from a bigint identity to a uuid holding a uuidv7.
-- No inbound FK references bank_tx.id (verified via pg_constraint), so the swap is self-contained.
--
-- Existing ids are regenerated here in OLD-ID ORDER. The embedded v7 timestamp therefore encodes
-- when this migration ran, NOT when the row was created; only the relative ordering of pre-migration
-- rows is meaningful. Rows inserted afterwards carry real creation timestamps and sort after this
-- block. Allocating one millisecond per row makes that ordering structural rather than dependent on
-- the random tail.
--
-- Layout (32 hex chars): 12 timestamp | 1 version '7' | 3 rand_a | 1 variant (8-b) | 15 rand_b.
CREATE OR REPLACE FUNCTION uuidv7_at(ms bigint) RETURNS uuid AS $$
DECLARE
  hex text;
BEGIN
  hex := lpad(to_hex(ms), 12, '0')
      || '7' || lpad(to_hex((random() * 4095)::int), 3, '0')
      || to_hex(8 + (random() * 3)::int)
      || lpad(to_hex((random() * 4294967295)::bigint), 8, '0')
      || lpad(to_hex((random() * 268435455)::bigint), 7, '0');
  RETURN hex::uuid;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
ALTER TABLE "bank_tx" ADD COLUMN "id_new" uuid;--> statement-breakpoint
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY id) AS rn FROM "bank_tx"
)
UPDATE "bank_tx" t
SET "id_new" = uuidv7_at(
  ((extract(epoch FROM now()) * 1000)::bigint - (SELECT count(*) FROM "bank_tx")) + o.rn
)
FROM ordered o
WHERE o.id = t.id;--> statement-breakpoint
ALTER TABLE "bank_tx" ALTER COLUMN "id_new" SET NOT NULL;--> statement-breakpoint
-- The primary key is still named banco_industrial_gt_txs_pkey, inherited through two table renames
-- (banco_industrial_gt_txs -> bank_txs -> bank_tx). Look it up rather than hardcoding, then re-add
-- below under the canonical bank_tx_pkey. Drizzle snapshots don't record PK constraint names for
-- column-level primary keys, so the rename is invisible to drizzle-kit.
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name
  FROM pg_constraint
  WHERE conrelid = 'bank_tx'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "bank_tx" DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "bank_tx" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "bank_tx" RENAME COLUMN "id_new" TO "id";--> statement-breakpoint
ALTER TABLE "bank_tx" ADD CONSTRAINT "bank_tx_pkey" PRIMARY KEY ("id");--> statement-breakpoint
DROP FUNCTION uuidv7_at(bigint);
