-- Hand-authored (drizzle-kit can't resolve the bank_txs -> bank_tx rename without a TTY).
-- Seeds bank_account from the existing distinct accounts, backfills bank_tx.bank_account_id, then
-- finalizes: NOT NULL, drop old key columns/index, rename table + its constraints/sequence, and
-- create the new unique index. Data-preserving. Ids are literal uuidv7 values (PG 15 has no uuidv7()).
INSERT INTO "bank_account" ("id", "bank_key", "account_number", "type") VALUES
	('019f631c-aa0a-777d-b714-4eebf86a8e2f', 'bacCr', 'CR93010200009615666272', 'checking'),
	('019f631c-aa0b-7493-af88-944bbb5453db', 'bacGt', '904201043', 'checking'),
	('019f631c-aa0b-7493-af88-9acf976e9040', 'bacGt', 'CR07010200009697902868', 'checking'),
	('019f631c-aa0b-7493-af88-9ef583b47786', 'bancoIndustrialGt', '3250099185', 'checking');
--> statement-breakpoint
UPDATE "bank_txs" AS bt SET "bank_account_id" = ba."id"
FROM "bank_account" AS ba
WHERE ba."bank_key" = bt."bank_key" AND ba."account_number" = bt."account_number";
--> statement-breakpoint
ALTER TABLE "bank_txs" ALTER COLUMN "bank_account_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "bank_txs_unique_cols";--> statement-breakpoint
ALTER TABLE "bank_txs" DROP COLUMN "bank_key";--> statement-breakpoint
ALTER TABLE "bank_txs" DROP COLUMN "account_number";--> statement-breakpoint
ALTER TABLE "bank_txs" RENAME TO "bank_tx";--> statement-breakpoint
ALTER TABLE "bank_tx" RENAME CONSTRAINT "bank_txs_bank_account_id_bank_account_id_fk" TO "bank_tx_bank_account_id_bank_account_id_fk";--> statement-breakpoint
ALTER TABLE "bank_tx" RENAME CONSTRAINT "bank_txs_payee_id_payee_id_fk" TO "bank_tx_payee_id_payee_id_fk";--> statement-breakpoint
ALTER TABLE "bank_tx" RENAME CONSTRAINT "bank_txs_category_id_category_id_fk" TO "bank_tx_category_id_category_id_fk";--> statement-breakpoint
ALTER TABLE "bank_tx" RENAME CONSTRAINT "bank_txs_transfer_bank_account_id_bank_account_id_fk" TO "bank_tx_transfer_bank_account_id_bank_account_id_fk";--> statement-breakpoint
ALTER SEQUENCE "bank_txs_id_seq" RENAME TO "bank_tx_id_seq";--> statement-breakpoint
CREATE UNIQUE INDEX "bank_tx_unique_cols" ON "bank_tx" USING btree ("bank_account_id","date","doc_no","description","amount");