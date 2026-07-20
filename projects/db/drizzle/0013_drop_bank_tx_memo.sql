-- Drops the `memo` column added in 0012.
--
-- It was introduced so the web app could annotate a transaction without touching `description`
-- (which is part of bank_tx_unique_cols, the scraper's match key). The register ended up showing
-- `description` directly and the memo field was removed from the row editor, so nothing wrote or
-- read the column. Verified empty before dropping: 0 non-null values across all 6786 rows.

ALTER TABLE "bank_tx" DROP COLUMN "memo";
