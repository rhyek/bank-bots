# bank-bots

Personal automation that pulls the owner's bank transactions from Central American banks and
syncs them into **YNAB** (You Need A Budget). It exists because these banks have no usable export
/ API, so transactions are scraped from their online-banking web UIs with a headless browser,
normalized into Postgres, and then reconciled into a YNAB budget.

> **Heads up (migration in progress):** the YNAB layer is being **replaced** with a different
> budgeting backend. As the first step, all YNAB **payees + categories** and each transaction's
> **payee/category mapping** have been mirrored into Postgres (`payee`, `category_group`, `category`
> tables + `bank_tx.payee_id`/`category_id`; run once via the backfill script below).
> `projects/update-ynab` (Go) + the `ynab` config block are now **legacy/reference only** — kept for
> now, not run; the daily YNAB sync is retired. Everything up to and including the `bank_tx` table is
> the stable core.

## Architecture at a glance

```
   ┌─────────────────────┐        ┌─────────────────────────┐        ┌──────────────────────┐
   │  scrape-txs (TS)     │        │  Postgres (Supabase)    │        │  update-ynab (Go)    │
   │  Playwright scraper  │ ─────▶ │  bank_account, bank_tx, │  ····▶ │  YNAB sync (LEGACY,  │
   │  per bank login      │ upsert │  payee, category, config│        │  retired / reference)│
   └─────────────────────┘        └─────────────────────────┘        └──────────────────────┘
         reads config                       ▲
         (bank creds)      backfill-ynab-mappings.ts (one-shot: YNAB payees/categories/mappings)
```

1. **Scrape** — `scrape-txs` logs into one bank (selected by a bank key), scrapes each account's
   transactions for the target month(s), resolves each account to its `bank_account.id`, and
   **upserts** them into `bank_tx`.
2. **Store** — Postgres is the source of truth. `bank_tx` (one row per transaction, keyed by
   `bank_account_id`) + `bank_account` (the account registry) + `payee`/`category_group`/`category`
   (imported from YNAB); a single-row `config` table holds all bank credentials + the (legacy) YNAB
   config as JSON.
3. **Sync (retired)** — `update-ynab` historically read `bank_txs` and pushed to YNAB. It's kept as
   reference only; the payee/category mappings it produced now live in `bank_tx` directly.

Both run on a **daily schedule** (historically AWS Lambda, ~13:00 UTC; on-failure the scraper emails
an alert). The deployment is mid-migration toward local/devtooie execution — `scrape-txs/lambda.ts`
and the `infra/` Terraform are removed in the working tree; `update-ynab` still has its Lambda
handler. Treat the scheduling/deploy story as in flux; the data pipeline below is what's stable.

## Repository layout (pnpm monorepo)

| Path | What |
| --- | --- |
| `projects/db/` | `@bank-bots/db` — shared Drizzle schema + client library. Owns the DB schema, migrations, and drizzle-kit. Consumed as **TypeScript source** (its `exports` point at `src/`; no build/emit) via the workspace link, by scrape-txs, tx-payees and web. |
| `projects/scrape-txs/` | TypeScript Playwright scraper (run via Node + `@swc-node/register`). Imports `@bank-bots/db`. |
| `projects/tx-payees/` | NestJS service. Keeps a local SQLite **replica** of Postgres and runs its **`payee-resolver`** module, which matches unmapped transactions to a payee + category in three tiers: exact description, `matching_rule` regex, then an **agent** (Claude Agent SDK) that can research a merchant and create the payees/rules its answer needs. See its own `CLAUDE.md`. |
| `projects/web/` | `@bank-bots/web` — TanStack Start (SSR) web app for browsing transactions: a YNAB-style transactions list with payee/category, time-window + search filters, and inline payee/category editing, plus a **Spending** page (per-month inflow/outflow/left-over + a category-group breakdown, drilling into a figure's transactions and on into the transactions list with that row highlighted). Reads/writes Postgres via server functions over `@bank-bots/db`. Port **3002**. See its own `CLAUDE.md`. |
| `projects/update-ynab/` | Go program that syncs `bank_txs` → YNAB. |
| `infra/` | Terraform for AWS (ECR/IAM/S3/Lambda). Currently being removed/reworked. |
| `devtooie.config.ts` | Local dev orchestration (see "Running" below). |
| `.env.local` | Secrets (gitignored): `DATABASE_URL`, `YNAB_BUDGET_ID`, `YNAB_ACCESS_TOKEN`, `MAILER_*`. |

## The banks

Three "bank keys", each = one bank login. `scrape-txs` picks one per run.

| Bank key | Bank / country | Login flow | Config accounts |
| --- | --- | --- | --- |
| `bancoIndustrialGt` | Banco Industrial, Guatemala | `bienlinea.bi.com.gt` (código + usuario + contraseña) | `3250099185` (checking), `3388707` (savings) |
| `bacGt` | BAC Credomatic, Guatemala | `baccredomatic.com` → pick country → "Banca en Línea" → `sucursalelectronica.com` login | `904201043` (USD checking), `CR07010200009697902868` (USD checking) |
| `bacCr` | BAC Credomatic, Costa Rica | same code as bacGt, `country: 'Costa Rica'` | `CR93010200009615666272` (USD checking) |

**Account types.** `config.banks.<key>.accounts[].type` selects the scrape path, and for
`bancoIndustrialGt` it is `checking` (Bi en Línea's *Monetarias*) or `savings` (*Ahorros*) — two
different sections of the site with different navigation, so the type is load-bearing, not a label.
An unknown type is now a build error rather than a silent skip.

> **Savings accounts reach back only two months.** Bi en Línea publishes savings statements as
> ACTUAL (current month) and ANTERIOR (previous) only. Its *Personalizado* form looks like a free
> date range, but the month selector offers exactly those two values and the date inputs only narrow
> within them — an older range returns "La cuenta no posee movimientos" rather than an error. So
> **`3388707` has no reachable history before the previous month**, and asking for an older month
> logs a skip and leaves stored rows untouched (it must not return an empty list: `run.ts` reads
> "nothing scraped" as "the bank deleted these" and would wipe the month). A checking account in the
> same run still backfills normally.

`bacGt` and `bacCr` share `src/lib/bac/scrape.ts`; `bancoIndustrialGt` has its own
`src/lib/banco-industrial/scrape.ts`. A bank config supports **multiple accounts** (the `accounts`
array), scraped in one login session.

## Component 1 — `scrape-txs` (the scraper)

Key files:
- `src/console.ts` — CLI entry. Options: `-b/--bank-key` (overrides `BANK_KEY` env),
  `-m/--month <months...>` (e.g. `2026-05`), `-t/--trace-dir <dir>`. On failure it emails a
  `Scrape bank txs failed for <bank>` alert (to `MAILER_ME`) and exits 1.
- `src/lib/run.ts` — orchestrator: loads `config` from the DB, launches Chromium (Playwright),
  runs the right scraper with **retries** (2 attempts, **fresh browser context per attempt** so a
  retry doesn't inherit cookies/session), then upserts results. On failure it saves a Playwright
  **trace** (`.zip`) to `--trace-dir` (default `storage/playwright-traces/`) for debugging.
- `src/lib/bac/scrape.ts`, `src/lib/banco-industrial/scrape.ts` — the per-bank Playwright flows.
- `src/lib/config-schema.ts` — Zod schema validating `config.data` (only the `banks` object; it
  intentionally ignores `ynab`).
- DB access is via the shared **`@bank-bots/db`** package (`projects/db`), not a local module. It
  owns the Drizzle client (`drizzle-orm/node-postgres` over `pg`), `schema.ts` (the source of truth,
  bootstrapped once via `drizzle-kit pull`, then evolved code-first), the migrations (`drizzle/`),
  and drizzle-kit. It also re-exports the drizzle-orm query operators (`inArray`, `eq`, …) so it's
  the sole owner of `drizzle-orm` (avoids duplicate-instance type clashes under pnpm). The scraper
  imports `{ db, bankTx, inArray, … }` from `@bank-bots/db`; reads use the RQB (`db.query.*`),
  writes/tx use the core API (`insert().onConflictDoUpdate()`, `delete()`, `db.transaction()`). It's
  consumed as **TS source** — no build/emit, so no `.js` extensions in its imports; consumers
  transpile it (scrape-txs via swc-node, the web app via Vite). Not a devtooie package (no process);
  the workspace link + package `exports` wire it in.

**Months**: if none passed, defaults to the current month (plus the previous month if today's day
≤ 10, to catch late-posting transactions).

**Upsert semantics** (`run.ts` + the per-bank scrapers): each account is first resolved to its
`bank_account.id` (`ensureBankAccount()` upserts the registry row). Insert into `bank_tx`; on
conflict against the `(bank_account_id, date, doc_no, description, amount_cents)` unique index, only
`amount_cents` is updated (this leaves any backfilled `payee_id`/`category_id` intact on re-scrape). It
also computes deletes (transactions in the DB for the scraped months that are no longer present on
the bank site) and removes them — so a scrape reconciles a month, it doesn't just append.

## Database schema (Supabase Postgres)

Six tables, all **singular**. **RLS is disabled** (the DB is reached only via a direct Postgres
connection, which bypasses RLS).

> **Id convention — every new table gets a uuidv7 primary key**, generated app-side via
> `uuid().primaryKey().$defaultFn(uuidv7)` (PG 15 has no `uuidv7()`, so generation is always in
> application code). `bank_account`, `bank_tx`, and `matching_rule` all follow this.
> **Exception:** `payee`/`category`/`category_group` keep the **YNAB uuids** they were imported
> with — those are foreign identifiers, not ids we mint.

Note that uuidv7 sorts lexicographically by creation time, so `ORDER BY id` is insertion order. It is
**not** transaction chronology — for that, order by `bank_tx.date`. (The 6786 rows that predate the
uuidv7 migration all carry that migration's timestamp; only their relative order is meaningful.)

**`bank_account`** — canonical account registry. `config.banks.<key>.accounts` still drives which
accounts get scraped + their credentials; this table gives each `(bank_key, account_number)` a stable
id that `bank_tx` references. Unique index `bank_account_unique_cols` on `(bank_key, account_number)`.
The scraper upserts rows here at scrape time via `ensureBankAccount()`.

| column | type | notes |
| --- | --- | --- |
| `id` | uuid | primary key (uuidv7, app-generated) |
| `bank_key` | text | e.g. `bacGt` |
| `account_number` | text | e.g. `904201043`, `CR93…` |
| `type` | text | `checking` (from config) |
| `currency` | text | `'USD'` for all rows (every tracked account is USD) |
| `name` | text | nullable; human label set from the web app. Null → UI falls back to `account_number` |
| `created_at` | timestamptz | `now()` |

**`bank_tx`** — one row per bank transaction (renamed from `bank_txs`; `bank_key`/`account_number`
replaced by the `bank_account_id` FK). Amounts are the bank's raw number (currency lives on `bank_account`).

| column | type | notes |
| --- | --- | --- |
| `id` | uuid | primary key (uuidv7, app-generated) |
| `bank_account_id` | uuid | **NOT NULL** FK → `bank_account.id` |
| `month` | text | `YYYY-MM` (the statement month scraped) |
| `date` | date | transaction date |
| `doc_no` | text | bank's document number (often non-unique / generic) |
| `description` | text | bank's description |
| `amount_cents` | bigint | integer cents; negative = debit, positive = credit |
| `payee_id` | text | nullable FK → `payee.id`; backfilled from YNAB |
| `category_id` | text | nullable FK → `category.id`; backfilled from YNAB |
| `transfer_bank_account_id` | uuid | nullable FK → `bank_account.id`; the *other* account for a transfer (payee/category stay null) |
| `reconcile` | boolean | manual reconciliation row — not on any bank statement. Scrapes never delete these, and `tx-payees` never matches them. **Replaced the old `doc_no = 'RECONCILE'` sentinel**, so new rows can carry a real doc number |
| `created_at` | timestamptz | `now()` on insert (not touched on conflict-update) |
| `updated_at` | timestamptz | maintained by the `trg_set_updated_at` trigger; the replica's delta-sync watermark |

Unique index `bank_tx_unique_cols` on `(bank_account_id, date, doc_no, description, amount_cents)` —
the upsert conflict target and effective natural key.

**`matcher_result`** — audit log of every payee/category decision, from every matching tier
(`id` uuidv7, `bank_tx_id` → `bank_tx`, `type` = `exact`|`rule`|`ai`|`none`, `payee_id`,
`category_id`, `source_tx_id` = the transaction an exact/rule match copied from, `matching_rule_id` =
the rule that fired, `data` jsonb, timestamps). Written by `tx-payees`. A `type = 'none'` row is
**terminal**: the backlog sweep skips that transaction from then on, which is what keeps
inter-account transfers (which can never have a payee) from costing an AI call on every boot. Re-ask
one with `DELETE FROM matcher_result WHERE bank_tx_id = '<uuid>' AND type = 'none';`

**`payee`** (`id`, `name`), **`category_group`** (`id`, `name`, `hidden`), **`category`** (`id`,
`name`, `group_id` → `category_group`, `hidden`) — imported wholesale from YNAB by the **backfill
script** (`projects/scrape-txs/src/scripts/backfill-ynab-mappings.ts`, run once, idempotent). It also
sets `bank_tx.payee_id`/`category_id` for every YNAB tx that had **both** a payee and a category,
matching it back to a `bank_tx` by `(bank_account, date, doc_no, amount)` — using the YNAB tx's own
date/amount + the `doc_no` parsed from its memo `ref: <YYYYMMDD_docno>`. (Only YNAB txs that had been
synced survive to match, so older `bank_tx` rows with no YNAB counterpart stay unmapped. This budget
had **no** native YNAB transfers, so `transfer_bank_account_id` is unset everywhere today — the
column + logic exist for the new backend.)

**`matching_rule`** — merchant patterns used by the tx-payees app's `payee-resolver` module (`id` uuidv7, `label`,
`pattern`, `priority`, `enabled`, `created_at`, `updated_at`; unique index on `label`). A rule holds
**no payee/category**: it only decides *where to look*. The answer always comes from the most recent
already-mapped transaction whose description matches — a rule that pinned an answer would reintroduce
the `forcePayee` behavior that was deliberately removed. `pattern` is a **JS regex source** (no
delimiters, no flags) evaluated in SQLite against the replica, because Postgres `~*` is POSIX and
cannot express the negative lookahead some patterns need. Seed with
`pnpm -C projects/tx-payees run seed-matching-rules` (idempotent, upserts on `label`). Rules are
live-replicated, so editing one in `psql` takes effect without restarting the agent.

**`config`** — single row, `id = 'general'`, `data json`. The whole app config lives in this JSON
blob (bank credentials + YNAB settings). Shape:

```jsonc
{
  "banks": {
    "bancoIndustrialGt": { "auth": { "code", "username", "password" }, "accounts": [{ "type", "number" }] },
    "bacGt": { "auth": { "username", "password" }, "country": "Guatemala",  "accounts": [{ "type", "number" }] },
    "bacCr": { "auth": { "username", "password" }, "country": "Costa Rica", "accounts": [{ "type", "number" }] }
  },
  "ynab": {                                   // ← the part being replaced
    "budgetId": "…", "accessToken": "…",
    "accountsMap": [ { "bankKey", "bankAccountNumber", "ynabAccountId" } ]  // one per scraped account
  }
}
```

> **Secrets live in this JSON** (bank passwords, YNAB token). `.env.local` also carries
> `DATABASE_URL` + the YNAB token/budget. Never print these; when reading `config.data` in shell,
> redact `auth` and `accessToken`.

## Component 2 — `update-ynab` (the YNAB sync) — *legacy / retired*

Go program (module `bank-bots/update-ynab`). Historically read `config` + `bank_txs` and pushed to
YNAB via its REST API (entry `main.go` `work()`). **Kept for reference only and no longer run** — it
still queries the old `bank_txs` table (now `bank_tx`, with `bank_key`/`account_number` replaced by
`bank_account_id`), so it won't work against the current schema without changes. The per-tx
payee/category assignments it produced now live directly in `bank_tx` (see the backfill script).

- **Account matching** (`ynab/ynab.go`): for each `(bank_key, account_number)` group with
  transactions, find the `config.ynab.accountsMap` entry with the same `bankKey` +
  `bankAccountNumber`, and use its `ynabAccountId`. **If an account has transactions but no map
  entry, the whole run errors** (`ynab account id not found …`) — so every scraped account must have
  an `accountsMap` entry (and a real YNAB account).
- **Ref / idempotency** (`banks/banks.go`): each bank tx gets `ref = YYYYMMDD_docno` (`(n)` suffix
  for collisions) and `amount` in **milliunits** (×1000, YNAB's unit). YNAB transactions carry a
  memo `ref: <ref>; desc: <description>;`, which is parsed back to match on re-runs.
- **Reconcile**: creates missing txs (no matching ref), updates amounts on matched txs that are
  still unapproved+uncleared, and flags (red) YNAB txs in-range whose ref no longer has a bank tx.
- **Range**: only the current/previous month by default (like the scraper). It does **not**
  backfill history.
- **`cmd/backfill/`** — a scoped one-off: backfills the *full* history of a **single** account into
  YNAB (env: `BACKFILL_FROM_MONTH=YYYY-MM`, `BACKFILL_BANK_KEY`, `BACKFILL_ACCOUNT_NUMBER`). Reuses
  the same reconcile code but filtered to one account, so it can't disturb other accounts. Use it
  when a newly-added account (or one that was down for a while) needs older months pushed to YNAB.
- `types/config.go` models **only** `config.ynab` (the `banks` half is unused by Go).

## Running things

Local runs go through **devtooie** (see the `devtooie` skill / `node_modules/devtooie/docs`). The
scraper is registered as a package with a one-shot `start` command.

```bash
# Scrape one bank (from repo root). Couple the run's log + trace in one dir via absolute paths —
# devtooie resolves --log-dir from the repo root, the scraper resolves --trace-dir from its own
# package dir, so relative paths would split them.
RUN_DIR="$PWD/storage/scrape-txs/run/<bankKey>-$(date +%Y%m%d-%H%M%S)"
pnpm devtooie cmd scrape-txs -c start --log-dir "$RUN_DIR" -- --bank-key <bankKey> [--month 2026-05 2026-06] --trace-dir "$RUN_DIR"

# Typecheck
pnpm -C projects/db run typecheck          # @bank-bots/db (source-only lib)
pnpm -C projects/scrape-txs run typecheck
pnpm -C projects/tx-payees run typecheck
pnpm -C projects/tx-payees test             # node --test (TxMatcher unit tests)
( cd projects/update-ynab && go build ./... && go vet ./... )

# DB migrations (Drizzle) — live in @bank-bots/db. Edit projects/db/src/schema.ts, then with
# DATABASE_URL in env (`set -a; . .env.local; set +a` from the repo root):
pnpm -C projects/db db:generate   # diff schema.ts → new drizzle/NNNN_*.sql migration
pnpm -C projects/db db:migrate    # apply pending migrations (tracked in drizzle.__drizzle_migrations)
# pnpm -C projects/db db:pull      # (rarely) re-introspect the live DB back into schema.ts
# The pre-existing tables were baselined into Drizzle's journal once via drizzle/stamp_baseline.sql,
# so `migrate` skips the 0000 baseline and only applies later migrations.
# NOTE: `db:generate` needs a TTY to resolve renames (table/column) and refuses to run in a
# non-interactive shell. For a rename or a data-preserving migration, hand-author the .sql and
# transform the previous meta/NNNN_snapshot.json — see 0003_finalize_bank_tx for the pattern
# (split the additive part into a normal `generate`, then a hand-written finalize; validate the
# hand-authored snapshot by re-running `db:generate` and expecting "No schema changes").

# Import YNAB payees/categories + per-tx mappings into Postgres (one-shot, idempotent).
# Needs DATABASE_URL + YNAB_ACCESS_TOKEN + YNAB_BUDGET_ID in env (source .env.local).
pnpm -C projects/scrape-txs run backfill-ynab-mappings

# tx-payees app: replica + payee-resolver. Matches unmapped transactions on boot, then continuously.
pnpm -C projects/tx-payees start
pnpm -C projects/tx-payees run seed-matching-rules   # one-shot, idempotent; seeds matching_rule

# web app: the transactions list. Hot-reloading dev server on :3002 (devtooie injects DATABASE_URL).
pnpm devtooie                                # whole workspace
pnpm devtooie cmd -p web -c dev              # just the web app
pnpm -C projects/web test                    # vitest (queries hit the real DB; mutations restore)
pnpm -C projects/web run typecheck
pnpm -C projects/web run build                # must pass: proves the ~/ alias + srvx bundle emit

# update-ynab (Go) is legacy/retired (see Component 2) — targets the old `bank_txs` schema, not run.
```

Inspect the DB directly with `psql "$DATABASE_URL"` (grab `DATABASE_URL` from `.env.local`).

## Conventions & gotchas

- **Scrapers break when a bank changes its site DOM** (a selector stops matching → 30s Playwright
  timeout). The **`fix-scrape-bugs` skill** documents the full diagnose→reproduce→fix loop and the
  trace-analysis cookbook; use it whenever a scrape fails or you're handed a trace/log. Known past
  break: BAC renamed its login button `.login-form__submit-btn` → `#confirm`.
- **`storage/`** is gitignored (traces, run logs). Never commit trace zips.
- **Never handle bank passwords / the YNAB token in plaintext.** Credential changes are done by the
  owner directly (e.g. a `psql` update they run themselves).
- **Currency** — **every account currently tracked is USD-denominated**. Currency lives once, on
  `bank_account.currency` (`'USD'` for all rows); `bank_tx` has **no** currency column (dropped in
  migration 0004 as redundant — an account is single-currency). If a non-USD account is ever added,
  set its `bank_account.currency`. Amounts are the bank's raw number regardless.
- Adding a new account = add it to the bank's `config.banks.<key>.accounts`, then scrape it — the
  scraper auto-creates the `bank_account` registry row (`ensureBankAccount`) and stamps
  `bank_account_id`. (The old YNAB step — create a YNAB account + `accountsMap` entry + `cmd/backfill`
  — is retired.)
- No AI attribution in commits/PRs (owner preference). Node scripts are authored as `.ts`.
