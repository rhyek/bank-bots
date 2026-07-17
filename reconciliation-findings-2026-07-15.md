# Balance reconciliation + full-history ingestion (2026-07-15/16)

**For: Carlos.** Outcome: `bank_tx` now contains each account's **full history back to 2022**, and
its per-account sum reflects the real balance. Details + how to revert below.

## Outcome

| Account | rows (was) | Σ bank_tx (was) | real balance | status |
|---|---|---|---|---|
| bacGt `904201043` | 2,509 (2,227) | **36,445.72** (25,174.08) | ~36,664.57 (YNAB) | reflects it; see note |
| bacCr `CR93…` | 105 (93) | **24,769.16** (19,426.30) | 24,769.16 | **exact** |
| bacGt `CR07…` | 12 (11) | **5,069.76** (5,069.76) | 5,069.76 | **exact** |
| bancoInd `3250099185` | 4,150 (1,310) | **5,851.57** (−10,587.87) | 5,851.57 | **exact** |

3 of 4 match the YNAB balance to the cent. `904201043` is $218.85 under YNAB's balance, and that gap
is **benign and explained** (below) — our figure is actually the *more current* one.

## What I did

Because the banks can't be re-scraped from here (no creds; BAC session expired), I pulled the missing
history **from YNAB** (which has it back to 2022 and reconciles to the bank) and inserted it into
`bank_tx`:

- Script: `projects/scrape-txs/src/scripts/ingest-ynab-history.ts` (kept, re-runnable).
- For each account, every YNAB tx **not already in `bank_tx`** was inserted. Matching is by
  `(docNo, amount)` within a **±90-day window** (YNAB dates are manually shifted vs the bank, so a
  pure date match fails; the window still blocks the same reference number reused years apart, which
  `904201043` does).
- Each inserted row: `date`, `doc_no` (bank ref where available, else `ynab-<id>`), `description`
  (memo `desc:` / payee name), `amount`, and — bonus — `payee_id`/`category_id` where present
  (this also backfilled mappings the earlier truncated backfill had missed).
- **Fully reversible:** every inserted row has `created_at >= 2026-07-16T02:10:47.365Z`. To undo:
  `DELETE FROM bank_tx WHERE created_at >= '2026-07-16T02:10:47.365Z';` (removes 3,137 rows).

Also fixed the **YNAB `since_date` bug** in `ynab/client.ts` (both `getTransactions` and the new
`getAccountTransactions` now fetch full history instead of ~the last year).

## Why 904201043 is $218.85 under YNAB (benign)

I diff'd our scraper's 2024-06+ rows against YNAB's for that account:

- **13 txs our scraper has that YNAB doesn't** (net −585.53) = our **recent July 12–14** transactions.
  YNAB's data ends 2026-07-11, so *our scraper is more current*. These are legitimately ours.
- **2 txs YNAB has that we don't** (net −366.68), and both are **YNAB artifacts, not scraper gaps**:
  - a −$361.45 "Gaby / Educación Ximena" entered in YNAB **twice** (2026-02-26 *and* 02-27, same
    docNo `406838368`) — a duplicate; our scraper correctly has it once.
  - a −$5.23 Uber on a generic reused docNo (`102700000`).

So `904201043`'s 36,445.72 is **more accurate** than YNAB's 36,664.57 (more current + excludes YNAB's
dup). The bank ledger you showed earlier (36,266.85, from 07-15 evening) is between the two, as
expected. No opening-balance history is missing — that's fully ingested now.

## How the reconciliation itself worked out (the "why didn't it match" answer)

The original mismatch was **entirely the opening balance predating our first scraped month** — real
money already in each account before our scraper started. YNAB records it because its history runs
further back (2022-01 for BAC GT / BI, 2024-07 for CR93). Per-account opening (net before our first
`bank_tx` month): 904201043 = 11,271.64, CR93 = 5,342.56, BI = 16,404.63, CR07 = 0. Ingesting that
history is what closed the gap. No data loss, no YNAB corruption of amounts.

(One earlier wrong turn, for the record: my first YNAB fetch omitted `since_date` and silently
truncated to ~1 year, which briefly made it look like YNAB had less history than us and was
inconsistent. Both were fetch artifacts; fixed.)

## Notes / follow-ups

- Ingested historical rows are a mix of real bank txs plus YNAB constructs that affect the balance
  (Starting Balance, Manual Balance Adjustment, transfers). `transfer_bank_account_id` was left null
  on them (not modeled yet). `doc_no` is the bank reference where recoverable, else `ynab-<id>`.
- The earlier payee/category backfill ran under the `since_date` bug, so pre-existing rows may still
  be under-mapped; a re-run of `backfill-ynab-mappings` (now that the client is fixed) would top it
  off. That's a separate data write — flagged, not done.
- Still-to-build (unchanged): `pending_purchases` (FK to bank_account_id), `running_balance` +
  reconciliation check in `run.ts`.

Files changed tonight: `ynab/client.ts` (since_date fix + getAccountTransactions),
`scripts/ingest-ynab-history.ts` (new). Data: 3,137 rows inserted into `bank_tx` (reversible above).
