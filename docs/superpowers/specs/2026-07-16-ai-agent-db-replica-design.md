# ai-agent `db-replica` — design

> **Superseded in part.** The app `ai-agent` is now **`tx-payees`** (`projects/tx-payees/`), and
> `DbReplicaModule` has been split into **`ReplicaDbModule`** (`replica-db/`, the SQLite client) and
> **`ReplicaSyncModule`** (`replica-sync/`, the replication). The replication design below still
> holds; only the module boundaries and names changed.

## Goal

A NestJS module in `projects/tx-payees` that maintains a **persistent local SQLite cache**
replicating three Postgres tables — `payee`, `category`, `bank_tx` — kept current in **real time**
via Postgres `LISTEN`/`NOTIFY`, and reconciled on boot with a cheap **delta sync**. The cache
persists across process restarts, so dev hot-reload (the `dev` script runs `node --watch`) does
near-zero work per restart instead of a full resync.

## Scope

- **Replicated**: `payee`, `category`, `bank_tx`. Order matters — `bank_tx` references `payee` and
  `category`, so those two sync first.
- **Not replicated**: `bank_account`, `category_group`, `config`. Columns that reference them
  (`bank_account_id`, `group_id`, `transfer_bank_account_id`) are mirrored as **plain columns** in
  SQLite — no FK, no join target. The replica does not enforce referential integrity (the source
  guarantees it); syncing payee/category before bank_tx just keeps a mid-sync reader consistent.
- **Read-only mirror**: the replica never writes back to Postgres.

## Postgres changes — new `@bank-bots/db` migration

1. **Columns** (added to `projects/db/src/schema.ts`):
   - `payee`, `category`: add `created_at timestamptz not null default now()` and
     `updated_at timestamptz not null default now()`.
   - `bank_tx`: add `updated_at timestamptz not null default now()` (it already has `created_at`).
   - The column adds are additive, so `pnpm -C projects/db db:generate` produces them with no TTY
     rename prompt. Existing rows get `now()` at migration time (we have no truer timestamps).

2. **`set_updated_at()`** — a `BEFORE INSERT OR UPDATE` row trigger on all three tables that sets
   `NEW.updated_at = now()`. It must be a DB trigger (not a Drizzle `$onUpdate`) because writes come
   from many paths — scrape-txs, the backfill scripts' raw `db.execute(UPDATE …)`, and manual
   `psql` — and only a trigger catches them all.

3. **`replica_notify()`** — an `AFTER INSERT OR UPDATE OR DELETE` row trigger on all three tables
   that calls `pg_notify('replica_events', payload)` where
   `payload = json_build_object('table', TG_TABLE_NAME, 'op', lower(TG_OP), 'id', <id>::text)`
   (`NEW.id` for insert/update, `OLD.id` for delete; cast to text since `bank_tx.id` is bigint and
   payee/category ids are text). Single channel, id-only payload — the listener reads the row itself.

   Triggers + trigger functions can't be modeled in the Drizzle schema, so this SQL is
   **hand-authored** and appended to the same migration (the repo already hand-authors SQL that
   drizzle-kit can't express — see migration 0003).

## ai-agent — `DbReplicaModule`

**Dependencies (scoped to ai-agent):** `better-sqlite3`, `drizzle-orm@^0.45.2` (pinned to
`@bank-bots/db`'s version so pnpm dedupes to one physical copy), `@types/better-sqlite3`, plus `pg` +
`@types/pg` (aligned to `@bank-bots/db`'s `^8.x`) for the dedicated LISTEN client. Also
`@bank-bots/db` via `workspace:*` for typed Postgres reads. The SQLite Drizzle instance lives
entirely in ai-agent; `@bank-bots/db` stays Postgres-only. The two Drizzle instances never exchange
objects — rows cross as plain JS.

- **SQLite file**: `projects/tx-payees/storage/replica.sqlite` — **gitignored, persistent**. This is
  the cache that survives restarts. Path overridable via env (default under the package's `storage/`).
- **SQLite schema (`drizzle-orm/sqlite-core`)**: `payee`, `category`, `bank_tx` mirroring the PG
  columns (+ `created_at`/`updated_at` stored as ISO text), plus a `sync_state(table_name PRIMARY
  KEY, last_updated_at TEXT)` bookkeeping table. Created at boot via `CREATE TABLE IF NOT EXISTS`
  (no drizzle-kit / SQLite migration tooling — it's a disposable local cache).

**Components:**

- **`ReplicaDb`** — owns the `better-sqlite3` connection + its Drizzle instance; runs the
  `CREATE TABLE IF NOT EXISTS` DDL on init; exposes the typed SQLite db to the rest of the app.
- **`ReplicaSync`** — the sync engine (boot delta + real-time listener). Reads Postgres through
  `@bank-bots/db` (`pool` + typed `db.query.*`, which now include the new timestamp columns).

### Boot delta sync (`OnModuleInit`)

For each table in dependency order (`payee` → `category` → `bank_tx`):

1. **Upserts**: `watermark = max(updated_at)` currently in SQLite for that table (none → epoch on the
   first ever run, i.e. a full initial load). `SELECT * FROM <t> WHERE updated_at >= watermark` from
   PG → upsert into SQLite. `>=` plus idempotent upsert avoids missing a same-timestamp boundary row.
2. **Deletes (id-diff)**: `SELECT id FROM <t>` from PG → delete from SQLite any id not in that set.

On a quiet hot-reload boot, step 1 returns ~0 rows and step 2 is a cheap id scan with no deletions.

### Real-time (`LISTEN`/`NOTIFY`)

- A dedicated standalone `pg.Client` (its own connection — `LISTEN` is connection-scoped, kept off
  the shared pool) runs `LISTEN replica_events`.
- On a `{table, op, id}` notification:
  - `insert` / `update` → typed `SELECT … WHERE id = :id` from PG → upsert into SQLite. This
    advances the SQLite watermark naturally because the stored row carries its `updated_at`.
    Idempotent: if the row changed again or was deleted before our SELECT, we get the latest or
    nothing and move on.
  - `delete` → delete from SQLite by id (no read needed — the row is gone).
- **Startup ordering**: connect + `LISTEN` **before** running the boot delta sync, so any event that
  fires during the snapshot is buffered and applied after it (idempotent). On a connection error,
  reconnect with backoff and **re-run the delta sync** to close any gap from the disconnect window.

## Lifecycle

`OnModuleInit`: open SQLite + DDL → connect listener + `LISTEN` → run boot delta sync.
`OnModuleDestroy`: close the listener client and the SQLite connection.

## Non-goals / YAGNI

- No tombstone table — the boot id-diff covers deletes that happened while ai-agent was offline.
- No SQLite migration tooling — runtime `CREATE TABLE IF NOT EXISTS`.
- No replica → Postgres writes.
- No FK enforcement inside SQLite.

## Testing

- **Unit** (`node:test`, as in scrape-txs): the delta-sync decision logic — given PG rows/ids and a
  SQLite state, assert the correct upserts and id-diff deletions; watermark computation.
- **Integration (scripted, manual run)**: boot ai-agent; run a script that inserts/updates/deletes
  in Postgres; assert SQLite reflects each within real time; restart ai-agent and assert it does a
  delta (no full resync) and stays consistent.
