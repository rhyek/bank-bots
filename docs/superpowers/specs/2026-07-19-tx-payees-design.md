# tx-payees — automatic payee/category matching in ai-agent

**Date:** 2026-07-19
**Status:** approved, ready for implementation plan
**Depends on:** [bank_tx uuidv7 PK](./2026-07-19-bank-tx-uuidv7-design.md) — lands first; transaction
ids are uuid strings throughout this spec, not numbers.

## Goal

Move payee/category matching out of the one-shot `scrape-txs` backfill script and into `ai-agent`
as a continuously-running module. Every `bank_tx` row with `payee_id IS NULL` gets matched against
already-mapped history and written back to Postgres — at startup for the backlog, and in real time
as new transactions arrive.

This is the first step. A later phase adds rule-based matching beyond the two tiers below.

## Background

`projects/scrape-txs/src/scripts/backfill-mappings-by-description.ts` is a manual, dry-run-by-default
script that matches unmapped transactions in two tiers: exact description, then a hard-coded list of
21 merchant regexes. Both tiers answer from history — they locate the most recent already-mapped
transaction that matches, and copy its `payee_id` + `category_id`. The regexes only decide *where to
look*; history decides the answer.

A third tier (`forcePayee`, which pinned one matcher to a fixed payee and overrode exact matching)
was removed on 2026-07-19, along with the data drift that motivated it. The design below preserves
that decision: **no rule ever pins an answer.**

`ai-agent` already maintains a SQLite replica of Postgres `payee`, `category`, `bank_tx` — a delta
sync on boot plus real-time `LISTEN/NOTIFY` updates. Because the whole transaction history is local,
the history lookups have no lookback limit (the Go original capped at one year).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where matches are written | Directly to Postgres `bank_tx` | Source of truth; the write's trigger emits NOTIFY, which flows back into SQLite on its own. No staging table. |
| Rule storage | New `matching_rule` table in Postgres, replicated to SQLite | Rules become editable without a deploy. Live-replicated, so edits apply without restarting the agent. |
| Rule semantics | **Selectors only** — no `payee_id`/`category_id` on the row | A rule with a fixed payee/category is `forcePayee` generalized. Rejected; history stays authoritative. |
| Exact-match tier | Intrinsic, not rule-backed | It is description equality against history. Expressing it as rows would mean one row per distinct description, stale on any bank formatting change. |
| Regex evaluation | SQLite, via a registered `regexp()` function | Patterns are JS regexes (`\b`, negative lookahead). Postgres `~*` is POSIX and rejects lookahead outright. |
| Reconciliation rows | New `bank_tx.reconcile` boolean | Replaces the `doc_no = 'RECONCILE'` sentinel, so manual rows no longer have to fake a document number. |
| Backlog cutoff | `date >= '2026-01-01'` (transaction date) | `created_at` is a new column: 3145 rows share a 2026-07-16 timestamp from the YNAB history ingest, spanning transaction dates back to 2022. A `created_at` cutoff selects 4020 rows vs 875 by `date`. |
| Queue ordering | `created_at ASC, id ASC` | `created_at` as requested; `id` breaks ties (154 in-scope rows share only 38 distinct `created_at` values). |
| Replica ↔ tx-payees coupling | `ReplicaSync` calls `txPayees.start()` and `txPayees.enqueue(id)` | Requested shape. Made acyclic by splitting the SQLite client out of the sync module (below). |

## Module structure

The existing `db-replica/` module is split in two. This is what keeps the dependency graph acyclic:
`tx-payees` needs the SQLite *client*, and `replica-sync` needs `tx-payees`. If both lived in one
module, that would be a cycle requiring `forwardRef`.

```
src/
  replica-db/                     NEW — the SQLite client only
    replica-db.module.ts          exports ReplicaDb
    replica-db.service.ts         moved from db-replica/; + registers regexp(); + schema versioning
    replica-schema.ts             moved from db-replica/; + matching_rule; + bank_tx.reconcile
  replica-sync/                   RENAMED from db-replica/
    replica-sync.module.ts        imports ReplicaDbModule, TxPayeesModule
    replica-sync.service.ts       + calls txPayees.start(); + enqueues on notify
    replica-status.controller.ts  renamed from replica.controller.ts
  tx-payees/                      NEW
    tx-payees.module.ts           imports ReplicaDbModule
    tx-payees.service.ts          public queue + start() + enqueue()
    tx-matcher.service.ts         two-tier resolution
```

Dependency graph: `ReplicaDb ← TxPayees ← ReplicaSync`, and `ReplicaDb ← ReplicaSync`. No cycle.

`db-replica/` and `replica-db/` as a name pair was rejected — the two differ only in word order.

## Schema changes

### Postgres — migration `0009`

```sql
-- 1. reconcile flag (replaces the doc_no sentinel)
ALTER TABLE bank_tx ADD COLUMN reconcile boolean NOT NULL DEFAULT false;
UPDATE bank_tx SET reconcile = true WHERE doc_no = 'RECONCILE';  -- 1 row today

-- 2. matching rules
CREATE TABLE matching_rule (
  id         uuid PRIMARY KEY,          -- uuidv7, app-generated ($defaultFn, as bank_account)
  label      text NOT NULL,
  pattern    text NOT NULL,             -- JS regex source; no delimiters, no flags
  priority   int  NOT NULL,             -- ascending; first match wins
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. attach the existing triggers so rules replicate live
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON matching_rule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE TRIGGER trg_replica_notify AFTER INSERT OR UPDATE OR DELETE ON matching_rule
  FOR EACH ROW EXECUTE FUNCTION replica_notify();
```

`created_at`/`updated_at` are required: the delta sync uses `max(updated_at)` as its watermark.

Both changes are additive, so `db:generate` should not prompt for rename resolution. The trigger
statements are hand-appended, following the pattern already used in `0007`.

**Seed:** the 21 patterns from `backfill-mappings-by-description.ts` `MATCHERS`, in their current
array order, with `priority` 10, 20, 30… preserving first-match-wins. Ported as regex *source
strings* (`\bspotify\b`). The `i` flag is applied by the registered `regexp()` function rather than
stored per row — all 21 are case-insensitive today. Per-rule flags are a future column if needed.

### SQLite replica — `replica-schema.ts`

- `bank_tx` gains `reconcile` — `INTEGER` with drizzle `mode: 'boolean'`, matching `category.hidden`.
- New `matching_rule` table mirroring the Postgres shape.
- `matching_rule` added to `ReplicaSync.tables`. No FK ordering concern; it references nothing.

### Replica schema versioning

`CREATE TABLE IF NOT EXISTS` cannot add `reconcile` to an existing `storage/replica.sqlite`, nor
create `matching_rule` beside a stale `bank_tx`. An existing replica file would silently keep the old
shape and every query touching a new column would throw.

`ReplicaDb.onModuleInit` gets a version stamp:

```ts
const EXPECTED_SCHEMA_VERSION = 1;  // existing unstamped files read 0 → dropped and rebuilt
const current = this.sqlite.pragma('user_version', { simple: true }) as number;
if (current !== EXPECTED_SCHEMA_VERSION) {
  this.sqlite.exec(DROP_SCHEMA_SQL);
  this.sqlite.exec(schema.CREATE_SCHEMA_SQL);
  this.sqlite.pragma(`user_version = ${EXPECTED_SCHEMA_VERSION}`);
}
```

Dropping empties the watermark, so the next `deltaSync` does a full re-pull — the intended recovery
for a disposable cache. Bump the constant whenever `replica-schema.ts` changes.

### `regexp()` registration

Registered in `ReplicaDb.onModuleInit` so every replica consumer has it:

```ts
this.sqlite.function('regexp', (pattern: string, value: string) =>
  value != null && new RegExp(pattern, 'i').test(value) ? 1 : 0,
);
```

SQLite has no built-in `REGEXP`. The grammar accepts the operator, but `X REGEXP Y` compiles to
`regexp(Y, X)` and SQLite defines no such function — statement *preparation* fails with
`no such function: REGEXP`. Note the argument order: the operator passes **pattern first**.

## Runtime behavior

### Startup

1. `ReplicaDb.onModuleInit` — open SQLite, version-check, create schema, register `regexp()`.
2. `ReplicaSync.onApplicationBootstrap` → `connectListener()`, then `deltaSync()`.
3. After the **first successful** `deltaSync`, `ReplicaSync` calls `txPayees.start()`, guarded by a
   flag so reconnect-triggered syncs don't call it again.
4. If the initial sync fails, `start()` is not called; existing backoff retries and `start()` fires
   on the first sync that succeeds.

### `TxPayees` public surface

```ts
readonly queue = new PQueue({ concurrency: 1 });   // public, per request
start(): void                                       // called by ReplicaSync after first sync
enqueue(txId: string): void                         // called by start() and the notify path
```

### `start()` — backlog sweep

```sql
SELECT id FROM bank_tx
WHERE payee_id IS NULL
  AND date >= '2026-01-01'
  AND transfer_bank_account_id IS NULL
  AND reconcile = 0
ORDER BY created_at ASC, id ASC
```

Each id goes through `enqueue()`. Transfers and reconciliation rows are excluded by design — both
carry deliberately-null payee/category.

### `enqueue(id)`

Dedups against an in-flight `Set<string>`, then `queue.add(() => this.process(id))`. One entry point
for both the backlog and the notify path.

### `process(id)`

Re-reads the transaction from SQLite — it may have changed between enqueue and execution — and
skips if `payee_id` is now set, or if it is a transfer or reconciliation row. Then:

1. **Exact tier.** Most recent transaction with an identical `description`, `payee_id IS NOT NULL`,
   `id <> self`, ordered `date DESC, id DESC LIMIT 1`. Copy its payee + category.
2. **Regex tier.** First `enabled` rule by `priority ASC` whose pattern matches this description.
   Then the most recent mapped transaction matching *that same pattern*, same ordering, excluding
   self. Copy its payee + category.
3. **Hit** → `UPDATE bank_tx SET payee_id = ?, category_id = ? WHERE id = ?` against Postgres.
4. **Miss** → log; leave null.

Both tiers exclude the transaction being matched, so a row can never source from itself.

### Notify path

In `ReplicaSync.onNotification`, after applying a `bank_tx` insert/update to SQLite: if the row's
`payee_id` is null, call `txPayees.enqueue(id)`. `ReplicaSync` already fetched that row from
Postgres to perform the upsert, so no extra query is needed.

### Termination

A successful match writes to Postgres → trigger → NOTIFY → `ReplicaSync` applies it → `payee_id` is
now non-null → not re-enqueued. A miss writes nothing, emits no NOTIFY, and cannot loop; it is
retried on the next boot, or whenever something else updates that row (a re-scrape changing
`amount_cents`, for instance) — which is the desired behavior.

### Replication lag is benign

The worker writes to Postgres while subsequent jobs read SQLite, so a just-matched transaction may
not have replicated before the next job runs. This does not affect results: a match always copies
values that **already exist** in history, so the next transaction resolves to the same payee and
category whether or not the new row has landed. No write-through to SQLite is needed.

## Error handling

- Each job is individually try/caught. A throwing job logs and the queue continues; one bad row
  never stalls the backlog.
- A failed Postgres write leaves the transaction unmapped, to be retried on the next boot.
- A malformed rule pattern (invalid regex) is caught per-rule, logged once, and skipped rather than
  failing the whole match.

## Testing

The matcher is the part worth testing. Seed an in-memory SQLite with the replica schema, insert
known history plus rules, and assert:

- exact match beats regex when both would hit
- sub-brand routing via negative lookahead (`pedidosya` must not swallow `pedidosya propina`)
- rule priority order — first match wins
- self-exclusion — a transaction never sources from itself
- no-match leaves payee/category null and writes nothing
- disabled rules are skipped

`ai-agent` has no test script yet; add `node --test` matching how `scrape-txs` does it.

## Out of scope

- Rule-based matching beyond these two tiers (the next phase).
- Retiring `backfill-mappings-by-description.ts`. It is left in place, updated only for the
  `reconcile` flag. It currently matches 0 of 760 remaining unmapped rows, so it is already
  effectively redundant, but removing it is a separate decision.
- Any change to `update-ynab` (legacy/retired).

## Follow-ups

- Per-rule regex flags, if a non-case-insensitive rule is ever needed.
- A review surface for matches, should AI-proposed payees arrive in a later phase.
