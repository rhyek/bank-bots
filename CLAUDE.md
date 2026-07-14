# bank-bots

Personal automation that pulls the owner's bank transactions from Central American banks and
syncs them into **YNAB** (You Need A Budget). It exists because these banks have no usable export
/ API, so transactions are scraped from their online-banking web UIs with a headless browser,
normalized into Postgres, and then reconciled into a YNAB budget.

> **Heads up (planned work):** the YNAB layer (`projects/update-ynab` + the `ynab` config block) is
> slated to be **replaced** with a different budgeting backend. Everything up to and including the
> `bank_txs` table is the stable core; the YNAB piece is the swappable part. This doc spells out the
> whole pipeline so that replacement can be scoped cleanly.

## Architecture at a glance

```
   ┌─────────────────────┐        ┌──────────────────┐        ┌──────────────────────┐
   │  scrape-txs (TS)     │        │  Postgres        │        │  update-ynab (Go)    │
   │  Playwright scraper  │ ─────▶ │  (Supabase)      │ ─────▶ │  reconcile → YNAB    │
   │  per bank login      │ upsert │  bank_txs, config│  read  │  via YNAB REST API   │
   └─────────────────────┘        └──────────────────┘        └──────────────────────┘
         reads config                                              reads config.ynab
         (bank creds)                                              (token + accountsMap)
```

1. **Scrape** — `scrape-txs` logs into one bank (selected by a bank key), scrapes each account's
   transactions for the target month(s), and **upserts** them into `bank_txs`.
2. **Store** — Postgres is the source of truth. One flat `bank_txs` table keyed by
   `(bank_key, account_number, …)`; a single-row `config` table holds all bank credentials + the
   YNAB config as JSON.
3. **Sync** — `update-ynab` reads `bank_txs`, matches each account to a YNAB account via
   `config.ynab.accountsMap`, and creates/updates transactions in YNAB (idempotent, memo-based).

Both run on a **daily schedule** (historically AWS Lambda, ~13:00 UTC; on-failure the scraper emails
an alert). The deployment is mid-migration toward local/devtooie execution — `scrape-txs/lambda.ts`
and the `infra/` Terraform are removed in the working tree; `update-ynab` still has its Lambda
handler. Treat the scheduling/deploy story as in flux; the data pipeline below is what's stable.

## Repository layout (pnpm monorepo)

| Path | What |
| --- | --- |
| `projects/db/` | `@bank-bots/db` — shared Drizzle schema + client library. Owns the DB schema, migrations, and drizzle-kit. Consumed as **TypeScript source** (its `exports` point at `src/`; no build/emit) via the workspace link, by scrape-txs (and the planned web app). |
| `projects/scrape-txs/` | TypeScript Playwright scraper (run via Node + `@swc-node/register`). Imports `@bank-bots/db`. |
| `projects/update-ynab/` | Go program that syncs `bank_txs` → YNAB. |
| `infra/` | Terraform for AWS (ECR/IAM/S3/Lambda). Currently being removed/reworked. |
| `devtooie.config.ts` | Local dev orchestration (see "Running" below). |
| `.env.local` | Secrets (gitignored): `DATABASE_URL`, `YNAB_BUDGET_ID`, `YNAB_ACCESS_TOKEN`, `MAILER_*`. |

## The banks

Three "bank keys", each = one bank login. `scrape-txs` picks one per run.

| Bank key | Bank / country | Login flow | Config accounts |
| --- | --- | --- | --- |
| `bancoIndustrialGt` | Banco Industrial, Guatemala | `bienlinea.bi.com.gt` (código + usuario + contraseña) | `3250099185` (checking) |
| `bacGt` | BAC Credomatic, Guatemala | `baccredomatic.com` → pick country → "Banca en Línea" → `sucursalelectronica.com` login | `904201043` (GTQ checking), `CR07010200009697902868` (USD checking) |
| `bacCr` | BAC Credomatic, Costa Rica | same code as bacGt, `country: 'Costa Rica'` | `CR93010200009615666272` (USD checking) |

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
  imports `{ db, bankTxs, inArray, … }` from `@bank-bots/db`; reads use the RQB (`db.query.*`),
  writes/tx use the core API (`insert().onConflictDoUpdate()`, `delete()`, `db.transaction()`). It's
  consumed as **TS source** — no build/emit, so no `.js` extensions in its imports; consumers
  transpile it (scrape-txs via swc-node, the web app via Vite). Not a devtooie package (no process);
  the workspace link + package `exports` wire it in.

**Months**: if none passed, defaults to the current month (plus the previous month if today's day
≤ 10, to catch late-posting transactions).

**Upsert semantics** (`run.ts`): insert into `bank_txs`; on conflict against the
`(bank_key, account_number, date, doc_no, description, amount)` unique index, only `amount` is
updated. It also computes deletes (transactions in the DB for the scraped months that are no longer
present on the bank site) and removes them — so a scrape reconciles a month, it doesn't just append.

## Database schema (Supabase Postgres)

**`bank_txs`** — one row per bank transaction. `id bigint` PK (auto). Amounts are stored as the
bank's raw number; the `currency` column labels which currency that number is in (`NOT NULL DEFAULT
'USD'` — see the currency gotcha below).

| column | type | notes |
| --- | --- | --- |
| `id` | bigint | primary key, auto-generated |
| `bank_key` | text | e.g. `bacGt` |
| `account_number` | text | e.g. `904201043`, `CR93…` |
| `month` | text | `YYYY-MM` (the statement month scraped) |
| `date` | date | transaction date |
| `doc_no` | text | bank's document number (often non-unique / generic) |
| `description` | text | bank's description |
| `amount` | numeric | negative = debit, positive = credit |
| `currency` | text | currency of `amount`; `NOT NULL DEFAULT 'USD'` (scrapers don't set it yet) |
| `created_at` | timestamptz | `now()` on insert (not touched on conflict-update) |

Unique index `bank_txs_unique_cols` on `(bank_key, account_number, date, doc_no, description,
amount)` — the upsert conflict target and the effective natural key. (`doc_no` alone isn't unique,
so the sync layer derives a per-account `ref` = `YYYYMMDD_docno` with a `(n)` suffix for
same-day/doc collisions — see below.)

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

## Component 2 — `update-ynab` (the YNAB sync) — *to be replaced*

Go program (module `bank-bots/update-ynab`). Reads `config` + `bank_txs`, pushes to YNAB via its
REST API. Entry: `main.go` (`work()`), runnable as a Lambda or CLI.

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
( cd projects/update-ynab && go build ./... && go vet ./... )

# DB migrations (Drizzle) — live in @bank-bots/db. Edit projects/db/src/schema.ts, then with
# DATABASE_URL in env (`set -a; . .env.local; set +a` from the repo root):
pnpm -C projects/db db:generate   # diff schema.ts → new drizzle/NNNN_*.sql migration
pnpm -C projects/db db:migrate    # apply pending migrations (tracked in drizzle.__drizzle_migrations)
# pnpm -C projects/db db:pull      # (rarely) re-introspect the live DB back into schema.ts
# The pre-existing tables were baselined into Drizzle's journal once via drizzle/stamp_baseline.sql,
# so `migrate` skips the 0000 baseline and only applies later migrations (e.g. 0001_add_currency).

# YNAB sync (Go) — normal recent-month run
( cd projects/update-ynab && DATABASE_URL=… go run . )
# YNAB backfill of one account's full history from a month
( cd projects/update-ynab && DATABASE_URL=… BACKFILL_FROM_MONTH=2026-04 BACKFILL_BANK_KEY=bacGt BACKFILL_ACCOUNT_NUMBER=904201043 go run ./cmd/backfill )
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
- **Currency** has a column (`bank_txs.currency`, `NOT NULL DEFAULT 'USD'`) but isn't meaningfully
  populated yet: the scrapers insert without setting it, so **every** row takes the `USD` default —
  including GTQ accounts, whose raw GTQ numbers are currently mislabelled `USD`. Making it real
  (set `currency` per account, sourced from config, in the scrapers) is future budgeting-backend
  work. Amounts remain the bank's raw number regardless.
- Adding a new account = add it to the bank's `config.banks.<key>.accounts`, scrape it, then (for
  the YNAB era) create a YNAB account + `accountsMap` entry, and backfill with `cmd/backfill`.
- No AI attribution in commits/PRs (owner preference). Node scripts are authored as `.ts`.
