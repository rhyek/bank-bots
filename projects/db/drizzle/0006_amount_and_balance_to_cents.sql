-- Store money as integer cents instead of numeric dollars.
-- bank_tx.amount -> amount_cents (bigint); bank_account.running_balance -> running_balance_cents.
-- Hand-authored (column rename + type change + data conversion; drizzle-kit can't do this in a
-- non-TTY shell). Data-preserving: values are multiplied by 100 and rounded to whole cents.
ALTER TABLE "bank_tx" ADD COLUMN "amount_cents" bigint;--> statement-breakpoint
UPDATE "bank_tx" SET "amount_cents" = round("amount" * 100)::bigint;--> statement-breakpoint
ALTER TABLE "bank_tx" ALTER COLUMN "amount_cents" SET NOT NULL;--> statement-breakpoint
DROP INDEX "bank_tx_unique_cols";--> statement-breakpoint
ALTER TABLE "bank_tx" DROP COLUMN "amount";--> statement-breakpoint
CREATE UNIQUE INDEX "bank_tx_unique_cols" ON "bank_tx" USING btree ("bank_account_id","date","doc_no","description","amount_cents");--> statement-breakpoint
ALTER TABLE "bank_account" ADD COLUMN "running_balance_cents" bigint;--> statement-breakpoint
UPDATE "bank_account" SET "running_balance_cents" = round("running_balance" * 100)::bigint;--> statement-breakpoint
ALTER TABLE "bank_account" DROP COLUMN "running_balance";