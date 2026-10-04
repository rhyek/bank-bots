# bank-bots

Personal automation that pulls the owner's bank transactions from Central American banks into
Postgres, where they are given a payee + category and browsed in a web app. It exists because these
banks have no usable export / API, so transactions are scraped from their online-banking web UIs
with a headless browser and normalized into Postgres.

> **YNAB is gone.** This project used to sync into **YNAB** (You Need A Budget) through a Go
> program, `projects/update-ynab`. That program and the one-shot scripts that imported from YNAB
> are deleted (all in git history); no code talks to YNAB anymore. What remains is data: YNAB's
> **payees + categories** and each transaction's **payee/category mapping** were mirrored into
> Postgres (`payee`, `category_group`, `category` tables + `bank_tx.payee_id`/`category_id`). The
> `ynab` block that used to sit in the `config` row, and the YNAB token and budget id, are removed.

## Architecture at a glance

```
   ┌─────────────────────┐        ┌─────────────────────────┐
   │  scrape-txs (TS)     │        │  Postgres (Supabase)    │
   │  Playwright scraper  │ ─────▶ │  bank_account, bank_tx, │
   │  per bank login      │ upsert │  payee, category, config│
   └─────────────────────┘        └─────────────────────────┘
         reads config
```

1. **Scrape** — `scrape-txs` logs into one bank (selected by a bank key), scrapes each account's
   transactions for the target month(s), resolves each account to its `bank_account.id`, and
   **upserts** them into `bank_tx`.
2. **Store** — Postgres is the source of truth. `bank_tx` (one row per transaction, keyed by
   `bank_account_id`) + `bank_account` (the account registry) + `payee`/`category_group`/`category`
   (imported from YNAB); a single-row `config` table holds, as JSON, which accounts to scrape and
   where each bank's credentials are in Bitwarden.

**Nothing runs in AWS anymore.** The scraper used to run daily on AWS Lambda (~13:00 UTC); those
Lambdas, the Terraform `infra/`, the Serverless config and the GitHub Actions deploy workflow have
all been torn down and deleted. The scraper is now a NestJS service that devtooie keeps running: it
scrapes every bank at 07:00 (America/Guatemala) from its own cron schedule, and on demand over a REST
endpoint (see "Running things"). On failure it emails an alert.

## Repository layout (pnpm monorepo)

| Path | What |
| --- | --- |
| `projects/db/` | `@bank-bots/db` — shared Drizzle schema + client library. Owns the DB schema, migrations, and drizzle-kit. Consumed as **TypeScript source** (its `exports` point at `src/`; no build/emit) via the workspace link, by scrape-txs, tx-payees and web. |
| `projects/scrape-txs/` | NestJS service around the Playwright scrapers: one daily cron that scrapes the three bank logins concurrently, a REST endpoint to scrape one on demand, and a `scrape_run` history. Port **22250**. Imports `@bank-bots/db`. See its own `CLAUDE.md`. |
| `projects/tx-payees/` | NestJS service. Keeps a local SQLite **replica** of Postgres and runs its **`payee-resolver`** module, which matches unmapped transactions to a payee + category in three tiers: exact description, `matching_rule` regex, then an **agent** (Claude Agent SDK) that can research a merchant and create the payees/rules its answer needs. It also records **location**: where each payee is, and where the owner was when each transaction was bought. See its own `CLAUDE.md`. |
| `projects/web/` | `@bank-bots/web` — TanStack Start (SSR) web app for browsing transactions: a YNAB-style transactions list with payee/category, time-window + search filters, and inline payee/category editing, plus a **Spending** page (per-month inflow/outflow/left-over + a category-group breakdown, drilling into a figure's transactions and on into the transactions list with that row highlighted). Reads/writes Postgres via server functions over `@bank-bots/db`. Port **3002**. See its own `CLAUDE.md`. |
| `devtooie.config.ts` | Local dev orchestration (see "Running" below). |
| `.env.local` | Secrets (gitignored): `DATABASE_URL`, `MAILER_*`. The scraper's Bitwarden bot credentials are in `projects/scrape-txs/.env.local`. |

## The banks

Three "bank keys", each = one bank login. A scrape **run** is one bank key; the daily schedule
starts a run for each, concurrently.

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
> logs a skip and leaves stored rows untouched (it must not return an empty list: the scrape reads
> "nothing scraped" as "the bank deleted these" and would wipe the month). A checking account in the
> same run still backfills normally.

`bacGt` and `bacCr` share `src/scrape/banks/bac/scrape.ts`; `bancoIndustrialGt` has its own
`src/scrape/banks/banco-industrial/scrape.ts`. A bank config supports **multiple accounts** (the `accounts`
array), scraped in one login session.

## `scrape-txs` (the scraper)

A NestJS 12 service; its own `CLAUDE.md` has the module layout, the isolation rules and the REST
contract. The short version:

- `src/scrape/scrape-schedule.service.ts` — the one cron: daily at 07:00 `America/Guatemala`, it
  starts a **batch** of the three bank keys.
- `src/scrape/scrape.controller.ts` — `POST /scrape/:bankKey` (body: `months`, `account`, `dryRun`;
  answers `202` at once), `GET /scrape/runs/:runId`, `GET /scrape/runs`. Validated with `nestjs-zod`.
- `src/scrape/scrape-runs.service.ts` — a batch stores a `scrape_run` row per bank, fetches the
  credentials of all its banks in **one** Bitwarden session (`src/credentials/`), then forks into
  one job per bank. One bank per run at a time (a second request gets `409`). A failed run emails a
  `Scrape bank txs failed for <bank>` alert (to `MAILER_ME`).
- `src/scrape/scrape-job.service.ts` — one bank: its **own headless Chromium**, **retries** (2
  attempts, **fresh browser context per attempt** so a retry doesn't inherit cookies/session), then
  upserts results. On the final failure it saves a Playwright **trace** to
  `projects/scrape-txs/storage/runs/<runId>/trace.zip`.
- `src/scrape/banks/bac/scrape.ts`, `src/scrape/banks/banco-industrial/scrape.ts` — the per-bank
  Playwright flows.
- `src/bank-config/config-schema.ts` — Zod schema validating `config.data` (its `banks` object).
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

**Months**: if none are requested, a run covers every month from 10 days before the bank's last
successful full scrape (read from `scrape_run`) through the current month — and never fewer than the
current month plus the previous one through the 10th, which catches late-posting transactions. So a
gap (the machine asleep at 07:00 for a week across a month end) is covered by the next run that does
happen; there is no catch-up of the missed tick itself. That reach is capped at 4 months: older
months are not scraped, and the owner is emailed the list to backfill by hand.

**Upsert semantics** (`scrape-job.service.ts` + the per-bank scrapers): each account is first resolved to its
`bank_account.id` (`ensureBankAccount()` upserts the registry row). Insert into `bank_tx`; on
conflict against the `(bank_account_id, date, doc_no, description, amount_cents, occurrence)` unique index, only
`amount_cents` is updated (this leaves any backfilled `payee_id`/`category_id` intact on re-scrape). It
also computes deletes (transactions in the DB for the scraped months that are no longer present on
the bank site) and removes them — so a scrape reconciles a month, it doesn't just append.

## Database schema (Supabase Postgres)

Twelve tables, all **singular**. **RLS is disabled** (the DB is reached only via a direct Postgres
connection, which bypasses RLS).

> **Id convention — every new table gets a uuidv7 primary key**, generated app-side via
> `uuid().primaryKey().$defaultFn(uuidv7)` (PG 15 has no `uuidv7()`, so generation is always in
> application code). `bank_account`, `bank_tx`, `matching_rule` and `scrape_run` all follow this.
> **Exceptions:** `payee`/`category`/`category_group` keep the **YNAB uuids** they were imported
> with — those are foreign identifiers, not ids we mint. `owner_day_location` is keyed by its
> `date` and `place_field` by its `field`: each holds one row per day / per city field by
> definition.

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
| `occurrence` | smallint | default 1. Tells apart bank rows identical on account, date, doc no, description and amount (BAC doc numbers are generic): 1 for the first such row on the statement, 2 for the next. Set by the scraper (`numberOccurrences`) |
| `payee_id` | text | nullable FK → `payee.id`; backfilled from YNAB |
| `category_id` | text | nullable FK → `category.id`; backfilled from YNAB |
| `transfer_bank_account_id` | uuid | nullable FK → `bank_account.id`; the *other* account for a transfer (payee/category stay null) |
| `country` | text | nullable; ISO 3166-1 alpha-2 code of where **the owner was** when the purchase happened. Not where the payee is (that is `payee.country`): an Amazon order placed from home is `GT` here and `US` on the payee. Written by `tx-payees`, never by the scraper |
| `location` | text | nullable; the place within `country` (city or area), from the same lookup |
| `reconcile` | boolean | manual reconciliation row — not on any bank statement. Scrapes never delete these, and `tx-payees` never matches them. **Replaced the old `doc_no = 'RECONCILE'` sentinel**, so new rows can carry a real doc number |
| `created_at` | timestamptz | `now()` on insert (not touched on conflict-update) |
| `updated_at` | timestamptz | maintained by the `trg_set_updated_at` trigger; the replica's delta-sync watermark |

Unique index `bank_tx_unique_cols` on `(bank_account_id, date, doc_no, description, amount_cents,
occurrence)` — the upsert conflict target and effective natural key. Without `occurrence` a bank
listing the same charge twice could be stored only once, and `SUM(amount_cents)` drifted from the
bank's balance.

**`scrape_run`** — one row per scrape of one bank login, written by `scrape-txs` (`id` uuidv7,
`bank_key`, `trigger` = `schedule`|`manual`, `status` = `running`|`succeeded`|`failed`, `started_at`,
`finished_at`, `months` text[] = the statement months scraped, `account` = set when only one account
was scraped, `dry_run`, `result` jsonb = `{ upserted, deleted, balancesUpdated, dryRunPath? }`,
`error` jsonb = `{ message, stage, tracePath? }`). It is the run history the REST endpoints serve,
and what a run with no months requested reads to decide how far back to scrape: the newest row that
is `succeeded`, not `dry_run`, has no `account`, and covered the month it ran in. A row left
`running` by a stopped process is failed on the service's next boot. Not replicated to `tx-payees`.

**`matcher_result`** — audit log of every payee/category decision, from every matching tier
(`id` uuidv7, `bank_tx_id` → `bank_tx`, `type` = `exact`|`rule`|`ai`|`none`, `payee_id`,
`category_id`, `source_tx_id` = the transaction an exact/rule match copied from, `matching_rule_id` =
the rule that fired, `data` jsonb, timestamps). Written by `tx-payees`. A `type = 'none'` row is
**terminal**: the backlog sweep stops asking for a payee for that transaction, which is what keeps
inter-account transfers (which can never have a payee) from costing an AI call on every sweep.
Re-ask one with `DELETE FROM matcher_result WHERE bank_tx_id = '<uuid>' AND type = 'none';`

It also holds **`type = 'location'`** rows: one per lookup of where the owner was for a transaction,
with `data = { purchaseDate, rule, country, location, final }`. `rule` is which lookup rule decided
it (`single-country`, `description-country`, `payee-country`, `posting-lag`, `none`); `final` is false while any day the
lookup rests on could still change, and such a transaction is looked up again on a later sweep. So
**any query for payee verdicts must filter on `type`**.

**`owner_day_location`** — where the owner was on each calendar day (UTC-6): `date` (primary key),
`country` (ISO alpha-2, null when unknown), `location`, `basis` (`observed` by the location tracker
| `inferred` from card charges or the surrounding days | `unknown`), `confidence`
(`high`|`medium`|`low`), `provisional` (true until the day is resolved at 10+ days old; provisional
days are resolved again), `data` jsonb (the evidence shown to the resolver and its reason),
timestamps. Written by `tx-payees`' day location resolver (an agent), one run of up to 14 days at a
time. Transactions look their day up here with no AI. To have days resolved again, delete their
rows; the transactions that used them are only redone if their `location` rows are deleted too.

**`place_field`** — what the 5-character "city" field at the end of a 30-character bank description
stands for: `field` (primary key, e.g. `GUATE`), `country` (ISO alpha-2; **null means the field is
not a place**, e.g. `OPENA` on an OpenAI charge), `place` (`Guatemala City`), `data` jsonb (the
descriptions the resolver was shown), timestamps. Filled by `tx-payees` (an agent), once per distinct
field. It is how a purchase at a physical business is placed in the country its own description
names. To correct an entry, update the row (or delete it to have the field asked about again),
then **restart `tx-payees`**: it loads this table once per process. Transactions already located
with a final lookup are not redone on their own; delete their `location` rows in `matcher_result`
to have them looked up again.

**`payee_location_result`** — audit log of every payee location decision (`id` uuidv7, `payee_id`
→ `payee` ON DELETE CASCADE, `kind`, `country`, `location`, `data` jsonb = the agent's summary,
confidence and the transaction that triggered it, timestamps). The values themselves live on
`payee`.

**`payee`** (`id`, `name`, `country`, `location`, `location_kind`), **`category_group`** (`id`, `name`, `hidden`), **`category`** (`id`,
`name`, `group_id` → `category_group`, `hidden`) — imported wholesale from YNAB by a one-shot
backfill script (`backfill-ynab-mappings.ts`, since deleted; in git history). It also set
`bank_tx.payee_id`/`category_id` for every YNAB tx that had **both** a payee and a category,
matching it back to a `bank_tx` by `(bank_account, date, doc_no, amount)` — using the YNAB tx's own
date/amount + the `doc_no` parsed from its memo `ref: <YYYYMMDD_docno>`. (Only YNAB txs that had been
synced survived to match, so older `bank_tx` rows with no YNAB counterpart stayed unmapped. That
budget had **no** native YNAB transfers, so the import set no `transfer_bank_account_id`.)

`payee.country` / `location` / `location_kind` say where **the business** is, and are set by
`tx-payees`' payee location matcher (an agent with web search), once per payee:

| `location_kind` | Meaning | `country` | `location` |
| --- | --- | --- | --- |
| `local` | one physical place | set | set, e.g. `Las Catalinas, Guanacaste` |
| `chain` | several branches, paid in person (supermarket, petrol, pharmacy, fast food) | the country when all its branches are in one (La Torre: `GT`); **null for a brand found in many** (Subway, Starbucks) | null |
| `remote` | paid without going anywhere: online services, and bills (phone, insurance, memberships) | where the company is based; null if that could not be found | null |
| `unknown` | looked up, not determinable (or not a business) | null | null |
| *NULL* | not looked up yet | null | null |

`location_kind` is the terminal marker: the matcher runs only while it is NULL. To re-ask, set it
back to NULL: `UPDATE payee SET location_kind = NULL WHERE id = '<id>';`

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
blob (which accounts to scrape). Shape:

```jsonc
{
  "banks": {
    "bancoIndustrialGt": { "bitwardenItemId": "…", "accounts": [{ "type", "number" }] },
    "bacGt": { "bitwardenItemId": "…", "country": "Guatemala",  "accounts": [{ "type", "number" }] },
    "bacCr": { "bitwardenItemId": "…", "country": "Costa Rica", "accounts": [{ "type", "number" }] }
  }
}
```

> **Bank credentials live in Bitwarden, not here.** Each bank's `bitwardenItemId` names a login item
> in the `automation` collection of the owner's `Personal` Bitwarden organization; the owner updates
> passwords there (e.g. from the browser extension) and nowhere else. The scraper reads them per batch
> through the `bw` CLI (`src/credentials/`: unlock → `sync` → `get item` per bank → lock), logged in as a
> dedicated read-only bot account whose CLI state is in `storage/bitwarden-cli/`. The bot's
> `BW_CLIENTID` / `BW_CLIENTSECRET` / `BW_PASSWORD` are in `projects/scrape-txs/.env.local`
> (gitignored; single-quote values containing `$`, or devtooie's loader expands them). Username and
> password are the item's own login fields; Bi en Línea's "Código" is its `campoInstalacion` custom
> field. A Bitwarden failure fails the run before any browser opens.
>
> `config.data` holds no secret anymore (the YNAB token it carried is removed). `.env.local` carries
> `DATABASE_URL` and the mailer password: never print those.

## Running things

Local runs go through **devtooie** (see the `devtooie` skill / `node_modules/devtooie/docs`). The
scraper is a long-running package on port **22250**; it scrapes on its own schedule, and a scrape is
started by hand over HTTP.

```bash
# Scrape one bank. Answers 202 with the run; body fields are all optional.
curl -s -X POST localhost:22250/scrape/<bankKey> -H 'content-type: application/json' \
  -d '{"months": ["2026-05", "2026-06"], "dryRun": true}'   # also: "account": "<number>"
curl -s localhost:22250/scrape/runs/<runId>   # running | succeeded | failed (+ result / error)
curl -s localhost:22250/scrape/runs           # the 50 most recent runs

# The service alone, when no devtooie session is running it (PORT + .env injected):
pnpm devtooie cmd -p scrape-txs -c start

# Typecheck
pnpm -C projects/db run typecheck          # @bank-bots/db (source-only lib)
pnpm -C projects/scrape-txs run typecheck
pnpm -C projects/scrape-txs test            # node --test
pnpm -C projects/tx-payees run typecheck
pnpm -C projects/tx-payees test             # node --test (TxMatcher unit tests)

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

# tx-payees app: replica + payee-resolver. Matches unmapped transactions on boot, then continuously.
pnpm -C projects/tx-payees start
pnpm -C projects/tx-payees run seed-matching-rules   # one-shot, idempotent; seeds matching_rule

# web app: the transactions list. Hot-reloading dev server on :3002 (devtooie injects DATABASE_URL).
pnpm devtooie                                # whole workspace
pnpm devtooie cmd -p web -c dev              # just the web app
pnpm -C projects/web test                    # vitest (queries hit the real DB; mutations restore)
pnpm -C projects/web run typecheck
pnpm -C projects/web run build                # must pass: proves the ~/ alias + srvx bundle emit
```

Inspect the DB directly with `psql "$DATABASE_URL"` (grab `DATABASE_URL` from `.env.local`).

## Conventions & gotchas

- **Scrapers break when a bank changes its site DOM** (a selector stops matching → 30s Playwright
  timeout). The **`fix-scrape-bugs` skill** documents the full diagnose→reproduce→fix loop and the
  trace-analysis cookbook; use it whenever a scrape fails or you're handed a trace/log. Known past
  break: BAC renamed its login button `.login-form__submit-btn` → `#confirm`.
- **`storage/`** is gitignored (traces and dry-run output under `projects/scrape-txs/storage/runs/`,
  the `bw` CLI state). Never commit trace zips.
- **Never handle bank passwords in plaintext.** Credential changes are done by the owner directly,
  in Bitwarden.
- **Currency** — **every account currently tracked is USD-denominated**. Currency lives once, on
  `bank_account.currency` (`'USD'` for all rows); `bank_tx` has **no** currency column (dropped in
  migration 0004 as redundant — an account is single-currency). If a non-USD account is ever added,
  set its `bank_account.currency`. Amounts are the bank's raw number regardless.
- Adding a new account = add it to the bank's `config.banks.<key>.accounts`, then scrape it (the
  `config` row is read on every batch, so no restart) — the scraper auto-creates the `bank_account` registry row (`ensureBankAccount`) and stamps
  `bank_account_id`.
- No AI attribution in commits/PRs (owner preference). Node scripts are authored as `.ts`.
