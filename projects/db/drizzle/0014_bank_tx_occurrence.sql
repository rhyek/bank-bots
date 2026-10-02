-- Adds `bank_tx.occurrence` and makes it the sixth column of bank_tx_unique_cols.
--
-- A bank can list two transactions identical on account, date, doc no, description and amount
-- (BAC's doc numbers are generic). The five-column key could hold only one of them, so the account's
-- SUM(amount_cents) drifted from the bank's balance. `occurrence` numbers such rows 1, 2, … in
-- statement order; every existing row is a first occurrence, hence the default of 1.

DROP INDEX "bank_tx_unique_cols";--> statement-breakpoint
ALTER TABLE "bank_tx" ADD COLUMN "occurrence" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_tx_unique_cols" ON "bank_tx" USING btree ("bank_account_id","date","doc_no","description","amount_cents","occurrence");