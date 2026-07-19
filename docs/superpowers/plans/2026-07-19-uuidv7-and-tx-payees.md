# uuidv7 PK + tx-payees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `bank_tx.id` to uuidv7, then add a `tx-payees` module to `ai-agent` that
continuously matches unmapped transactions to a payee + category and writes the result to Postgres.

**Architecture:** Phase 1 swaps the `bank_tx` primary key and propagates the string id type through
the replica and scripts. Phase 2 splits `db-replica/` into `replica-db/` (SQLite client) +
`replica-sync/` (Postgres→SQLite sync), then adds `tx-payees/` — a `p-queue` worker with
concurrency 1, started by `ReplicaSync` after its first successful delta sync and fed both by a
startup backlog sweep and by the LISTEN/NOTIFY path.

**Tech Stack:** NestJS 12 (native ESM, no build step), Drizzle ORM, Postgres 15 (Supabase),
better-sqlite3, `p-queue`, `uuid@14`.

**Specs:** [bank_tx uuidv7](../specs/2026-07-19-bank-tx-uuidv7-design.md) ·
[tx-payees](../specs/2026-07-19-tx-payees-design.md)

## Global Constraints

- Migrations are **hand-authored** where `db:generate` cannot model the change (PK type change,
  triggers). Follow the `0003_finalize_bank_tx` pattern: write the `.sql`, transform the previous
  `meta/NNNN_snapshot.json`, add a `_journal.json` entry, then validate with `db:generate` expecting
  "No schema changes".
- `DATABASE_URL` comes from `.env.local` — `set -a; . ./.env.local; set +a` from the repo root.
- **Never print or commit** bank credentials or the YNAB token from `config.data`.
- No AI attribution in commit messages (owner preference).
- Node scripts are `.ts`, run via `node --import @swc-node/register/esm-register`.
- `@bank-bots/db` is consumed as TS source — no `.js` extensions in its imports.
- uuidv7 PKs are generated **app-side** (`$defaultFn(uuidv7)`); PG 15 has no `uuidv7()`.
- Migration numbering: `0008` = uuidv7, `0009` = reconcile + matching_rule.

---

# Phase 1 — bank_tx uuidv7 primary key

### Task 1: Migration 0008 — convert `bank_tx.id` to uuidv7

**Files:**
- Modify: `projects/db/src/schema.ts:1-12` (imports), `:77` (id column)
- Create: `projects/db/drizzle/0008_bank_tx_uuidv7_pk.sql`
- Create: `projects/db/drizzle/meta/0008_snapshot.json` (transformed from `0007_snapshot.json`)
- Modify: `projects/db/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `bankTx.id` typed `string` throughout `@bank-bots/db` consumers.

- [ ] **Step 1: Back up the table before touching it**

```bash
set -a && . ./.env.local && set +a
pg_dump "$DATABASE_URL" -t bank_tx --data-only -f storage/bank_tx_pre_uuidv7.sql
wc -l storage/bank_tx_pre_uuidv7.sql
```

Expected: a non-empty file. `storage/` is gitignored.

- [ ] **Step 2: Record the pre-migration baseline**

```bash
set -a && . ./.env.local && set +a
psql "$DATABASE_URL" -c "SELECT count(*) AS rows, min(id) AS min_id, max(id) AS max_id FROM bank_tx;"
```

Expected: 6786 rows. Note the number — Step 7 asserts it is unchanged.

- [ ] **Step 3: Write the migration SQL**

Create `projects/db/drizzle/0008_bank_tx_uuidv7_pk.sql`:

```sql
-- Hand-authored: drizzle-kit cannot model a primary-key type change.
-- Converts bank_tx.id from bigint identity to uuid holding a uuidv7.
-- No inbound FK references bank_tx.id (verified via pg_constraint), so the swap is self-contained.
--
-- Existing ids are regenerated at migration time in OLD-ID ORDER. The embedded v7 timestamp
-- therefore encodes when the migration ran, not when the row was created; only the RELATIVE
-- ordering of pre-migration rows is meaningful. Rows inserted afterwards carry real timestamps and
-- sort after this block. One millisecond per row makes the ordering structural rather than
-- dependent on the random tail.
CREATE OR REPLACE FUNCTION uuidv7_at(ms bigint) RETURNS uuid AS $$
DECLARE
  hex text;
BEGIN
  -- 48-bit big-endian millisecond timestamp, then version 7 + variant 10 + random remainder.
  hex := lpad(to_hex(ms), 12, '0')
      || '7' || lpad(to_hex((random() * 4095)::int), 3, '0')
      || to_hex(8 + (random() * 3)::int)
      || lpad(to_hex((random() * 4294967295)::bigint), 8, '0')
      || lpad(to_hex((random() * 268435455)::bigint), 7, '0');
  RETURN hex::uuid;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

ALTER TABLE "bank_tx" ADD COLUMN "id_new" uuid;--> statement-breakpoint

WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY id) AS rn FROM "bank_tx"
)
UPDATE "bank_tx" t
SET "id_new" = uuidv7_at(
  ((extract(epoch FROM now()) * 1000)::bigint - (SELECT count(*) FROM "bank_tx")) + o.rn
)
FROM ordered o
WHERE o.id = t.id;--> statement-breakpoint

ALTER TABLE "bank_tx" ALTER COLUMN "id_new" SET NOT NULL;--> statement-breakpoint
-- The PK is still named banco_industrial_gt_txs_pkey, inherited through two table renames. Look it
-- up rather than hardcoding, then re-add below as the canonical bank_tx_pkey.
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name
  FROM pg_constraint
  WHERE conrelid = 'bank_tx'::regclass AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "bank_tx" DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "bank_tx" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "bank_tx" RENAME COLUMN "id_new" TO "id";--> statement-breakpoint
ALTER TABLE "bank_tx" ADD CONSTRAINT "bank_tx_pkey" PRIMARY KEY ("id");--> statement-breakpoint
DROP FUNCTION uuidv7_at(bigint);
```

- [ ] **Step 4: Update the Drizzle schema**

In `projects/db/src/schema.ts:77`, replace:

```ts
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
```

with:

```ts
    id: uuid().primaryKey().$defaultFn(uuidv7),
```

`uuid` and `uuidv7` are already imported (lines 10 and 12). Leave `bigint` imported — still used by
`runningBalanceCents` and `amountCents`.

- [ ] **Step 5: Create the snapshot and journal entry**

Copy `projects/db/drizzle/meta/0007_snapshot.json` to `0008_snapshot.json`, then inside it:
- change the top-level `"id"` to a fresh uuid and `"prevId"` to `0007_snapshot.json`'s `"id"`
- in `public.bank_tx.columns.id`, set `"type": "uuid"`, remove `"identity"`, keep
  `"primaryKey": true` and `"notNull": true`

Append to `projects/db/drizzle/meta/_journal.json`'s `entries` array:

```json
    {
      "idx": 8,
      "version": "7",
      "when": 1784500000000,
      "tag": "0008_bank_tx_uuidv7_pk",
      "breakpoints": true
    }
```

- [ ] **Step 6: Apply the migration**

```bash
set -a && . ./.env.local && set +a
pnpm -C projects/db db:migrate
```

Expected: applies `0008_bank_tx_uuidv7_pk` with no error.

- [ ] **Step 7: Verify data integrity and ordering**

```bash
set -a && . ./.env.local && set +a
psql "$DATABASE_URL" -c "
SELECT count(*) AS rows, count(DISTINCT id) AS distinct_ids,
       count(*) FILTER (WHERE id IS NULL) AS nulls
FROM bank_tx;"
psql "$DATABASE_URL" -c "
SELECT data_type FROM information_schema.columns
WHERE table_name='bank_tx' AND column_name='id';"
```

Expected: `rows = distinct_ids = 6786`, `nulls = 0`, `data_type = uuid`.

- [ ] **Step 8: Verify the schema snapshot is honest**

```bash
set -a && . ./.env.local && set +a
pnpm -C projects/db db:generate
```

Expected: "No schema changes, nothing to migrate". If it wants to emit a migration, the snapshot in
Step 5 is wrong — fix it rather than accepting the generated file.

- [ ] **Step 9: Typecheck and commit**

```bash
pnpm -C projects/db run typecheck
git add projects/db/src/schema.ts projects/db/drizzle/
git commit -m "feat(db): bank_tx uuidv7 primary key"
```

---

### Task 2: Propagate string ids through replica and scripts

**Files:**
- Modify: `projects/ai-agent/src/db-replica/replica-schema.ts:26` (bankTx.id), `:58` (DDL)
- Modify: `projects/ai-agent/src/db-replica/replica-sync.service.ts:29-32,53`
- Modify: `projects/scrape-txs/src/scripts/backfill-mappings-by-description.ts`
- Modify: `projects/scrape-txs/src/scripts/backfill-ynab-mappings.ts:25` and its `VALUES` casts

**Interfaces:**
- Consumes: `bankTx.id: string` from Task 1.
- Produces: replica `bankTx.id` typed `text`; `castId` identity for all three tables.

- [ ] **Step 1: Change the replica column type**

In `replica-schema.ts:26`, replace `id: integer('id').primaryKey(),` with:

```ts
  id: text('id').primaryKey(),
```

In `CREATE_SCHEMA_SQL` (line ~58), replace `id INTEGER PRIMARY KEY,` in the `bank_tx` block with:

```sql
  id TEXT PRIMARY KEY,
```

- [ ] **Step 2: Simplify `castId`**

In `replica-sync.service.ts`, replace the comment at lines 29-30 and the `bank_tx` descriptor:

```ts
// A replicated table: its Postgres source (@bank-bots/db) + SQLite mirror. All replicated ids are
// text (bank_tx is a uuidv7; payee/category are YNAB uuids), so the notify payload needs no casting.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Descriptor = { name: string; pg: any; lite: any };
```

and drop `castId` from all three entries:

```ts
  private readonly tables: Descriptor[] = [
    { name: 'payee', pg: pgPayee, lite: litePayee },
    { name: 'category', pg: pgCategory, lite: liteCategory },
    { name: 'bank_tx', pg: pgBankTx, lite: liteBankTx },
  ];
```

At line ~211, replace `const id = t.castId(evt.id);` with:

```ts
    const id = evt.id;
```

- [ ] **Step 3: Update the description backfill script**

In `backfill-mappings-by-description.ts`, change `interface Row`'s `id: number;` to `id: string;`,
and `interface Plan`'s `id: number;` to `id: string;`. In the sources sort, replace the id tiebreaker
`b.id - a.id` with a string comparison:

```ts
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id.localeCompare(a.id)));
```

In the apply block, change the cast:

```ts
      batch.map((u) => sql`(${u.id}::uuid, ${u.payeeId}::text, ${u.categoryId}::text)`),
```

- [ ] **Step 4: Update the YNAB mappings script**

In `backfill-ynab-mappings.ts:25`, change `id: number;` to `id: string;`. Change both
`WHERE t.id = v.id` `VALUES` blocks' id cast from `::bigint` to `::uuid`.

- [ ] **Step 5: Typecheck both packages**

```bash
pnpm -C projects/scrape-txs run typecheck
pnpm -C projects/ai-agent run typecheck
```

Expected: both clean.

- [ ] **Step 6: Verify the backfill script still behaves**

```bash
set -a && . ./.env.local && set +a
pnpm -C projects/scrape-txs run backfill-mappings-by-description 2>&1 | head -3
```

Expected: `sources (mapped): 5928 | targets (unmapped): 760 | matched: 0 | unmatched: 760` — the
same baseline as before the id change.

- [ ] **Step 7: Commit**

```bash
git add projects/ai-agent/src projects/scrape-txs/src
git commit -m "refactor: string bank_tx ids across replica and backfill scripts"
```

---

# Phase 2 — tx-payees

### Task 3: Split `db-replica/` into `replica-db/` + `replica-sync/`

**Files:**
- Create: `projects/ai-agent/src/replica-db/{replica-db.module.ts,replica-db.service.ts,replica-schema.ts}`
- Create: `projects/ai-agent/src/replica-sync/{replica-sync.module.ts,replica-sync.service.ts,replica-status.controller.ts}`
- Delete: `projects/ai-agent/src/db-replica/`
- Modify: `projects/ai-agent/src/app.module.ts`

**Interfaces:**
- Produces: `ReplicaDbModule` exporting `ReplicaDb`; `ReplicaSyncModule` importing it.

- [ ] **Step 1: Move the files with git**

```bash
cd /Users/carlos/Dev/personal/bank-bots/projects/ai-agent/src
mkdir -p replica-db replica-sync
git mv db-replica/replica-db.service.ts replica-db/replica-db.service.ts
git mv db-replica/replica-schema.ts     replica-db/replica-schema.ts
git mv db-replica/replica-sync.service.ts replica-sync/replica-sync.service.ts
git mv db-replica/replica.controller.ts   replica-sync/replica-status.controller.ts
git rm db-replica/db-replica.module.ts
```

- [ ] **Step 2: Fix the `~/` import paths**

Every `~/db-replica/replica-schema` becomes `~/replica-db/replica-schema`; every
`~/db-replica/replica-db.service` becomes `~/replica-db/replica-db.service`. Affected files:
`replica-db/replica-db.service.ts`, `replica-sync/replica-sync.service.ts`,
`replica-sync/replica-status.controller.ts`.

```bash
cd /Users/carlos/Dev/personal/bank-bots/projects/ai-agent/src
grep -rl "~/db-replica/" . | xargs sed -i '' 's|~/db-replica/|~/replica-db/|g'
grep -rn "~/db-replica/" . || echo "no stale imports"
```

- [ ] **Step 3: Rename the controller class**

In `replica-sync/replica-status.controller.ts`, rename `ReplicaController` to
`ReplicaStatusController` (class declaration only; the `@Controller('replica')` route stays).

- [ ] **Step 4: Create `replica-db/replica-db.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { ReplicaDb } from '~/replica-db/replica-db.service';

// Owns the local SQLite replica connection. Deliberately independent of the sync service so feature
// modules can read the replica without depending on replication itself (which would be a cycle:
// replica-sync drives tx-payees, tx-payees reads the replica).
@Module({
  providers: [ReplicaDb],
  exports: [ReplicaDb],
})
export class ReplicaDbModule {}
```

- [ ] **Step 5: Create `replica-sync/replica-sync.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { ReplicaStatusController } from '~/replica-sync/replica-status.controller';
import { ReplicaSync } from '~/replica-sync/replica-sync.service';

// Keeps the SQLite replica current: a delta sync on boot + real-time LISTEN/NOTIFY updates.
@Module({
  imports: [ReplicaDbModule],
  controllers: [ReplicaStatusController],
  providers: [ReplicaSync],
})
export class ReplicaSyncModule {}
```

- [ ] **Step 6: Update `app.module.ts`**

Replace the `DbReplicaModule` import and entry with `ReplicaSyncModule` (importing
`~/replica-sync/replica-sync.module`). `ReplicaDbModule` does not need to be listed in `AppModule` —
it is pulled in transitively.

- [ ] **Step 7: Typecheck and boot**

```bash
pnpm -C projects/ai-agent run typecheck
set -a && . ./.env.local && set +a && timeout 25 pnpm -C projects/ai-agent start 2>&1 | head -25
```

Expected: typecheck clean; startup logs `SQLite replica ready at …`, `listening on 'replica_events'`,
and three `sync …` lines.

- [ ] **Step 8: Commit**

```bash
git add -A projects/ai-agent/src
git commit -m "refactor(ai-agent): split db-replica into replica-db + replica-sync"
```

---

### Task 4: Migration 0009 — `reconcile` flag + `matching_rule`

**Files:**
- Modify: `projects/db/src/schema.ts` (bank_tx `reconcile`, new `matchingRule` table)
- Create: `projects/db/drizzle/0009_reconcile_and_matching_rule.sql`
- Create: `projects/db/drizzle/meta/0009_snapshot.json`, modify `meta/_journal.json`
- Modify: `projects/scrape-txs/src/lib/bac/scrape.ts:282`,
  `projects/scrape-txs/src/lib/banco-industrial/scrape.ts:85`,
  `projects/scrape-txs/src/scripts/backfill-mappings-by-description.ts`

**Interfaces:**
- Produces: `bankTx.reconcile: boolean`; `matchingRule` table with
  `{ id: string; label: string; pattern: string; priority: number; enabled: boolean }`.

- [ ] **Step 1: Add the schema definitions**

In `projects/db/src/schema.ts`, add to the `bankTx` column block (after `transferBankAccountId`):

```ts
    // Manual reconciliation rows: not present on any bank statement, so scrapes must never delete
    // them and matching must never target them. Replaces the old `doc_no = 'RECONCILE'` sentinel.
    reconcile: boolean().notNull().default(false),
```

And append a new table:

```ts
// Merchant patterns used by ai-agent's tx-payees module. A rule only decides WHERE to look: the
// payee/category always come from the most recent already-mapped transaction matching the pattern,
// never from the rule itself. Patterns are JS regex sources evaluated in SQLite (Postgres `~*` is
// POSIX and rejects lookahead), matched case-insensitively.
export const matchingRule = pgTable(
  'matching_rule',
  {
    id: uuid().primaryKey().$defaultFn(uuidv7),
    label: text().notNull(),
    pattern: text().notNull(),
    priority: bigint({ mode: 'number' }).notNull(),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  // Unique so the seed script can upsert on label (onConflictDoUpdate needs a unique target).
  (table) => [uniqueIndex('matching_rule_label_unique').on(table.label)],
);
```

- [ ] **Step 2: Generate the additive migration**

```bash
set -a && . ./.env.local && set +a
pnpm -C projects/db db:generate
```

Both changes are additive, so this should not prompt. It emits
`drizzle/0009_*.sql` — rename the file to `0009_reconcile_and_matching_rule.sql` and update the
`tag` in `_journal.json` to match.

- [ ] **Step 3: Append the backfill and triggers by hand**

Add to the end of `projects/db/drizzle/0009_reconcile_and_matching_rule.sql`:

```sql
--> statement-breakpoint
-- Backfill the flag from the old sentinel; doc_no keeps its value but stops being load-bearing.
UPDATE "bank_tx" SET "reconcile" = true WHERE "doc_no" = 'RECONCILE';--> statement-breakpoint
-- Hand-authored (drizzle-kit can't model triggers): keep updated_at correct and replicate rule
-- edits to the ai-agent replica in real time, exactly as the other replicated tables do.
CREATE OR REPLACE TRIGGER trg_set_updated_at BEFORE INSERT OR UPDATE ON "matching_rule"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_replica_notify AFTER INSERT OR UPDATE OR DELETE ON "matching_rule"
  FOR EACH ROW EXECUTE FUNCTION replica_notify();
```

- [ ] **Step 4: Apply and verify**

```bash
set -a && . ./.env.local && set +a
pnpm -C projects/db db:migrate
psql "$DATABASE_URL" -c "SELECT count(*) FILTER (WHERE reconcile) AS reconciled FROM bank_tx;"
psql "$DATABASE_URL" -c "\d matching_rule"
```

Expected: `reconciled = 1`; `matching_rule` exists with the seven columns.

- [ ] **Step 5: Switch the four call sites off the sentinel**

`projects/scrape-txs/src/lib/bac/scrape.ts:282` and
`projects/scrape-txs/src/lib/banco-industrial/scrape.ts:85` — replace
`if (currentTx.docNo === 'RECONCILE') return false;` with:

```ts
            if (currentTx.reconcile) return false;
```

`projects/scrape-txs/src/scripts/backfill-mappings-by-description.ts` — in `interface Row` replace
`docNo: string;` with `reconcile: boolean;`, in the `findMany` `columns` block replace
`docNo: true,` with `reconcile: true,`, and in the targets filter replace
`r.docNo !== 'RECONCILE',` with:

```ts
      !r.reconcile,
```

- [ ] **Step 6: Typecheck and verify behavior is unchanged**

```bash
pnpm -C projects/db run typecheck && pnpm -C projects/scrape-txs run typecheck
set -a && . ./.env.local && set +a
pnpm -C projects/scrape-txs run backfill-mappings-by-description 2>&1 | head -3
```

Expected: typechecks clean; the same `760 targets / 0 matched` baseline.

- [ ] **Step 7: Commit**

```bash
git add projects/db projects/scrape-txs/src
git commit -m "feat(db): bank_tx.reconcile flag + matching_rule table"
```

---

### Task 5: Replica schema — `reconcile`, `matching_rule`, versioning, `regexp()`

**Files:**
- Modify: `projects/ai-agent/src/replica-db/replica-schema.ts`
- Modify: `projects/ai-agent/src/replica-db/replica-db.service.ts`
- Modify: `projects/ai-agent/src/replica-sync/replica-sync.service.ts` (tables list)

**Interfaces:**
- Produces: `matchingRule` SQLite table; `ReplicaDb` with a working `regexp()` SQL function and
  `user_version`-gated schema rebuild.

- [ ] **Step 1: Add `reconcile` and `matchingRule` to the replica schema**

In `replica-schema.ts`, add to the `bankTx` table definition:

```ts
  reconcile: integer('reconcile', { mode: 'boolean' }).notNull(),
```

Add a new table:

```ts
export const matchingRule = sqliteTable('matching_rule', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  pattern: text('pattern').notNull(),
  priority: integer('priority').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

In `CREATE_SCHEMA_SQL`, add `reconcile INTEGER NOT NULL,` to the `bank_tx` block and append:

```sql
CREATE TABLE IF NOT EXISTS matching_rule (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS matching_rule_updated_at ON matching_rule (updated_at);
CREATE INDEX IF NOT EXISTS bank_tx_payee_id ON bank_tx (payee_id);
CREATE INDEX IF NOT EXISTS bank_tx_description ON bank_tx (description);
```

Then add the drop script, used when the version stamp does not match:

```ts
// Applied when the stored user_version doesn't match EXPECTED_SCHEMA_VERSION. The replica is a
// disposable cache: dropping empties the delta-sync watermark, so the next sync does a full re-pull.
export const DROP_SCHEMA_SQL = `
DROP TABLE IF EXISTS matching_rule;
DROP TABLE IF EXISTS bank_tx;
DROP TABLE IF EXISTS category;
DROP TABLE IF EXISTS payee;
`;
```

- [ ] **Step 2: Add versioning and `regexp()` to `ReplicaDb`**

In `replica-db.service.ts`, import `DROP_SCHEMA_SQL` alongside the schema namespace, add the
constant above the class:

```ts
// Bump whenever replica-schema.ts changes shape. Existing unstamped files read 0 and get rebuilt.
const EXPECTED_SCHEMA_VERSION = 1;
```

and replace the body of `onModuleInit` between `this.sqlite.pragma('journal_mode = WAL');` and
`this.db = drizzle(...)` with:

```ts
    const version = this.sqlite.pragma('user_version', { simple: true }) as number;
    if (version !== EXPECTED_SCHEMA_VERSION) {
      this.logger.log(`replica schema v${version} != v${EXPECTED_SCHEMA_VERSION}; rebuilding`);
      this.sqlite.exec(schema.DROP_SCHEMA_SQL);
    }
    this.sqlite.exec(schema.CREATE_SCHEMA_SQL);
    this.sqlite.pragma(`user_version = ${EXPECTED_SCHEMA_VERSION}`);
    // SQLite ships no REGEXP implementation — `X REGEXP Y` compiles to regexp(Y, X) and fails at
    // prepare() with "no such function". Supplying it here gives JS regex semantics (the rule
    // patterns use \b and negative lookahead, which Postgres's POSIX `~*` cannot express).
    // Note the argument order: the operator passes the PATTERN first.
    this.sqlite.function('regexp', (pattern: string, value: string) =>
      value != null && new RegExp(pattern, 'i').test(value) ? 1 : 0,
    );
```

- [ ] **Step 3: Replicate `matching_rule`**

In `replica-sync.service.ts`, import `matchingRule as pgMatchingRule` from `@bank-bots/db` and
`matchingRule as liteMatchingRule` from `~/replica-db/replica-schema`, then add to `tables`:

```ts
    { name: 'matching_rule', pg: pgMatchingRule, lite: liteMatchingRule },
```

- [ ] **Step 4: Boot and verify the rebuild**

```bash
pnpm -C projects/ai-agent run typecheck
set -a && . ./.env.local && set +a && timeout 40 pnpm -C projects/ai-agent start 2>&1 | head -30
```

Expected: a `replica schema v0 != v1; rebuilding` line, then four `sync …` lines with full row
counts (a complete re-pull), including `sync matching_rule`.

- [ ] **Step 5: Commit**

```bash
git add projects/ai-agent/src
git commit -m "feat(ai-agent): replicate matching_rule; replica schema versioning + regexp()"
```

---

### Task 6: `TxMatcher` — the two-tier resolution

**Files:**
- Create: `projects/ai-agent/src/tx-payees/tx-matcher.service.ts`
- Create: `projects/ai-agent/src/tx-payees/tx-matcher.service.test.ts`
- Modify: `projects/ai-agent/package.json` (add `test` script)

**Interfaces:**
- Consumes: `ReplicaDb` from Task 3; `matchingRule` + `bankTx` replica tables from Task 5.
- Produces: `TxMatcher.match(tx: MatchableTx): MatchResult | null` where
  `MatchableTx = { id: string; description: string }` and
  `MatchResult = { payeeId: string; categoryId: string; via: string }`.

- [ ] **Step 1: Add the test script to `package.json`**

In `projects/ai-agent/package.json` `scripts`, add:

```json
    "test": "node --import @swc-node/register/esm-register --test --test-isolation=none 'src/**/*.test.ts'",
```

- [ ] **Step 2: Write the failing test**

Create `projects/ai-agent/src/tx-payees/tx-matcher.service.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '~/replica-db/replica-schema';
import { TxMatcher } from '~/tx-payees/tx-matcher.service';

// An in-memory replica standing in for ReplicaDb. Mirrors what ReplicaDb.onModuleInit does:
// create the schema and register regexp().
function makeReplica() {
  const sqlite = new Database(':memory:');
  sqlite.exec(schema.CREATE_SCHEMA_SQL);
  sqlite.function('regexp', (pattern: string, value: string) =>
    value != null && new RegExp(pattern, 'i').test(value) ? 1 : 0,
  );
  return { raw: sqlite, db: drizzle(sqlite, { schema }) };
}

let replica: ReturnType<typeof makeReplica>;
let matcher: TxMatcher;
let seq = 0;

function addTx(
  description: string,
  opts: { payeeId?: string; categoryId?: string; date?: string } = {},
) {
  const id = `tx-${String(++seq).padStart(4, '0')}`;
  replica.db
    .insert(schema.bankTx)
    .values({
      id,
      bankAccountId: 'acct-1',
      month: '2026-07',
      date: opts.date ?? '2026-07-01',
      docNo: 'D1',
      description,
      amountCents: -1000,
      payeeId: opts.payeeId ?? null,
      categoryId: opts.categoryId ?? null,
      transferBankAccountId: null,
      reconcile: false,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
    })
    .run();
  return id;
}

function addRule(label: string, pattern: string, priority: number, enabled = true) {
  replica.db
    .insert(schema.matchingRule)
    .values({
      id: `rule-${label}`,
      label,
      pattern,
      priority,
      enabled,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
    })
    .run();
}

describe('TxMatcher', () => {
  before(() => {
    replica = makeReplica();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    matcher = new TxMatcher(replica as any);
  });
  after(() => replica.raw.close());

  it('prefers an exact description match over a regex rule', () => {
    addRule('spotify', String.raw`\bspotify\b`, 10);
    addTx('SPOTIFY GT', { payeeId: 'p-regex', categoryId: 'c-regex', date: '2026-01-01' });
    addTx('SPOTIFY  MONTHLY', { payeeId: 'p-exact', categoryId: 'c-exact', date: '2026-02-01' });
    const target = addTx('SPOTIFY  MONTHLY');

    const res = matcher.match({ id: target, description: 'SPOTIFY  MONTHLY' });
    assert.equal(res?.payeeId, 'p-exact');
    assert.equal(res?.via, 'exact');
  });

  it('falls back to a regex rule and copies from history, not the rule', () => {
    addTx('TIGO PAGO 123', { payeeId: 'p-tigo', categoryId: 'c-tigo', date: '2026-03-01' });
    addRule('tigo', String.raw`\btigo\b`, 20);
    const target = addTx('TIGO PAGO 999');

    const res = matcher.match({ id: target, description: 'TIGO PAGO 999' });
    assert.equal(res?.payeeId, 'p-tigo');
    assert.equal(res?.via, 'regex:tigo');
  });

  it('routes sub-brands via negative lookahead', () => {
    addRule('pedidosya propina', String.raw`\bpedidos\s*ya\s+propina`, 30);
    addRule('pedidosya', String.raw`\bpedidos\s*ya\b(?!\s+propina)`, 40);
    addTx('PEDIDOSYA PROPINA X', { payeeId: 'p-propina', categoryId: 'c-misc', date: '2026-04-01' });
    addTx('PEDIDOSYA FOOD X', { payeeId: 'p-food', categoryId: 'c-rest', date: '2026-04-01' });

    const propina = addTx('PEDIDOSYA PROPINA ZZZ');
    const food = addTx('PEDIDOSYA FOOD ZZZ');
    assert.equal(matcher.match({ id: propina, description: 'PEDIDOSYA PROPINA ZZZ' })?.payeeId, 'p-propina');
    assert.equal(matcher.match({ id: food, description: 'PEDIDOSYA FOOD ZZZ' })?.payeeId, 'p-food');
  });

  it('never sources from itself', () => {
    const solo = addTx('UNIQUE MERCHANT XYZ');
    assert.equal(matcher.match({ id: solo, description: 'UNIQUE MERCHANT XYZ' }), null);
  });

  it('skips disabled rules', () => {
    addTx('DISNEY PLUS', { payeeId: 'p-disney', categoryId: 'c-disney', date: '2026-05-01' });
    addRule('disney', String.raw`\bdisney\b`, 50, false);
    const target = addTx('DISNEY SOMETHING ELSE');
    assert.equal(matcher.match({ id: target, description: 'DISNEY SOMETHING ELSE' }), null);
  });

  it('returns null when nothing matches', () => {
    const target = addTx('COMPLETELY NOVEL MERCHANT');
    assert.equal(matcher.match({ id: target, description: 'COMPLETELY NOVEL MERCHANT' }), null);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm -C projects/ai-agent test 2>&1 | tail -20
```

Expected: FAIL — cannot resolve `~/tx-payees/tx-matcher.service`.

- [ ] **Step 4: Implement `TxMatcher`**

Create `projects/ai-agent/src/tx-payees/tx-matcher.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { bankTx, matchingRule } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';

export interface MatchableTx {
  id: string;
  description: string;
}

export interface MatchResult {
  payeeId: string;
  categoryId: string;
  via: string;
}

// Resolves a payee + category for an unmapped transaction from already-mapped history, in two tiers:
// exact description first, then merchant regex rules by priority. A rule only selects WHICH history
// row to copy — the answer always comes from history, never from the rule. Both tiers exclude the
// transaction being matched, so a row can never source from itself.
@Injectable()
export class TxMatcher {
  private readonly logger = new Logger(TxMatcher.name);

  constructor(private readonly replica: ReplicaDb) {}

  match(tx: MatchableTx): MatchResult | null {
    const exact = this.mostRecentMapped(ne(bankTx.id, tx.id), eq(bankTx.description, tx.description));
    if (exact) return { ...exact, via: 'exact' };

    for (const rule of this.rules()) {
      let matches: boolean;
      try {
        matches = new RegExp(rule.pattern, 'i').test(tx.description);
      } catch (err) {
        this.logger.warn(`skipping rule '${rule.label}': bad pattern (${(err as Error).message})`);
        continue;
      }
      if (!matches) continue;
      const src = this.mostRecentMapped(
        ne(bankTx.id, tx.id),
        sql`${bankTx.description} REGEXP ${rule.pattern}`,
      );
      if (src) return { ...src, via: `regex:${rule.label}` };
    }
    return null;
  }

  private rules() {
    return this.replica.db
      .select({ label: matchingRule.label, pattern: matchingRule.pattern })
      .from(matchingRule)
      .where(eq(matchingRule.enabled, true))
      .orderBy(matchingRule.priority)
      .all();
  }

  // Most recent fully-mapped transaction satisfying the extra predicates. `date DESC, id DESC`
  // matches the backfill script's ordering; uuidv7 ids are lexicographically time-ordered, so the
  // id tiebreaker still means "most recently created".
  private mostRecentMapped(
    ...where: Parameters<typeof and>
  ): { payeeId: string; categoryId: string } | null {
    const row = this.replica.db
      .select({ payeeId: bankTx.payeeId, categoryId: bankTx.categoryId })
      .from(bankTx)
      .where(and(isNotNull(bankTx.payeeId), isNotNull(bankTx.categoryId), ...where))
      .orderBy(sql`${bankTx.date} DESC`, sql`${bankTx.id} DESC`)
      .limit(1)
      .get();
    return row?.payeeId && row.categoryId
      ? { payeeId: row.payeeId, categoryId: row.categoryId }
      : null;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm -C projects/ai-agent test 2>&1 | tail -20
```

Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add projects/ai-agent/src/tx-payees projects/ai-agent/package.json
git commit -m "feat(ai-agent): TxMatcher two-tier payee/category resolution"
```

---

### Task 7: `TxPayees` — queue, backlog sweep, worker

**Files:**
- Create: `projects/ai-agent/src/tx-payees/tx-payees.service.ts`
- Create: `projects/ai-agent/src/tx-payees/tx-payees.module.ts`
- Modify: `projects/ai-agent/package.json` (add `p-queue`)

**Interfaces:**
- Consumes: `TxMatcher.match()` from Task 6; `ReplicaDb` from Task 3.
- Produces: `TxPayees` with `readonly queue: PQueue`, `start(): void`, `enqueue(txId: string): void`.

- [ ] **Step 1: Add `p-queue`**

```bash
pnpm -C projects/ai-agent add p-queue
```

- [ ] **Step 2: Implement the service**

Create `projects/ai-agent/src/tx-payees/tx-payees.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import PQueue from 'p-queue';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { bankTx as pgBankTx, db as pgDb, eq as pgEq } from '@bank-bots/db';
import { bankTx } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import { TxMatcher } from '~/tx-payees/tx-matcher.service';

// Only transactions on or after this date are matched; earlier history is left as-is.
const FROM_DATE = '2026-01-01';

// Matches unmapped bank_tx rows to a payee + category and writes the result to Postgres. Fed by a
// backlog sweep at startup and by the replica's LISTEN/NOTIFY path for new rows. Concurrency is 1:
// jobs run strictly in order, and the queue is public so ReplicaSync can push into it.
@Injectable()
export class TxPayees {
  private readonly logger = new Logger(TxPayees.name);
  readonly queue = new PQueue({ concurrency: 1 });
  private readonly pending = new Set<string>();
  private started = false;

  constructor(
    private readonly replica: ReplicaDb,
    private readonly matcher: TxMatcher,
  ) {}

  /** Called by ReplicaSync once the first delta sync has completed. Idempotent. */
  start() {
    if (this.started) return;
    this.started = true;
    const rows = this.replica.db
      .select({ id: bankTx.id })
      .from(bankTx)
      .where(
        and(
          isNull(bankTx.payeeId),
          isNull(bankTx.transferBankAccountId),
          eq(bankTx.reconcile, false),
          sql`${bankTx.date} >= ${FROM_DATE}`,
        ),
      )
      .orderBy(asc(bankTx.createdAt), asc(bankTx.id))
      .all();
    this.logger.log(`backlog: ${rows.length} unmapped transactions since ${FROM_DATE}`);
    for (const r of rows) this.enqueue(r.id);
  }

  /** Queue a transaction for matching. Safe to call repeatedly; duplicates are ignored. */
  enqueue(txId: string) {
    if (this.pending.has(txId)) return;
    this.pending.add(txId);
    void this.queue.add(() => this.process(txId));
  }

  private async process(txId: string) {
    try {
      const tx = this.replica.db
        .select({
          id: bankTx.id,
          description: bankTx.description,
          payeeId: bankTx.payeeId,
          transferBankAccountId: bankTx.transferBankAccountId,
          reconcile: bankTx.reconcile,
          date: bankTx.date,
        })
        .from(bankTx)
        .where(eq(bankTx.id, txId))
        .get();
      // Re-check: the row may have changed (or been mapped) between enqueue and execution.
      if (!tx || tx.payeeId != null || tx.transferBankAccountId != null || tx.reconcile) return;
      if (tx.date < FROM_DATE) return;

      const result = this.matcher.match({ id: tx.id, description: tx.description });
      if (!result) {
        this.logger.debug(`no match: "${tx.description}"`);
        return;
      }
      // Write to Postgres (the source of truth). The trigger emits NOTIFY, which brings the values
      // back into SQLite; since payee_id is then set, the row is not re-enqueued.
      await pgDb
        .update(pgBankTx)
        .set({ payeeId: result.payeeId, categoryId: result.categoryId })
        .where(pgEq(pgBankTx.id, txId));
      this.logger.log(`${result.via}: "${tx.description}" -> ${result.payeeId}`);
    } catch (err) {
      this.logger.error(`process ${txId}: ${(err as Error).message}`);
    } finally {
      this.pending.delete(txId);
    }
  }
}
```

- [ ] **Step 3: Create the module**

Create `projects/ai-agent/src/tx-payees/tx-payees.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { TxMatcher } from '~/tx-payees/tx-matcher.service';
import { TxPayees } from '~/tx-payees/tx-payees.service';

// Depends only on the replica CLIENT, never on replica-sync — replica-sync drives this module, so
// depending on it here would be a cycle.
@Module({
  imports: [ReplicaDbModule],
  providers: [TxMatcher, TxPayees],
  exports: [TxPayees],
})
export class TxPayeesModule {}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -C projects/ai-agent run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add projects/ai-agent
git commit -m "feat(ai-agent): TxPayees queue + backlog sweep + worker"
```

---

### Task 8: Wire `ReplicaSync` → `TxPayees`

**Files:**
- Modify: `projects/ai-agent/src/replica-sync/replica-sync.service.ts`
- Modify: `projects/ai-agent/src/replica-sync/replica-sync.module.ts`

**Interfaces:**
- Consumes: `TxPayees.start()` and `TxPayees.enqueue()` from Task 7.

- [ ] **Step 1: Import the module**

In `replica-sync.module.ts`, add `TxPayeesModule` to `imports`:

```ts
import { TxPayeesModule } from '~/tx-payees/tx-payees.module';
// ...
  imports: [ReplicaDbModule, TxPayeesModule],
```

- [ ] **Step 2: Inject `TxPayees` and start it after the first sync**

In `replica-sync.service.ts`, add the import and constructor parameter:

```ts
import { TxPayees } from '~/tx-payees/tx-payees.service';
// ...
  constructor(
    private readonly replica: ReplicaDb,
    private readonly txPayees: TxPayees,
  ) {}
```

Add a field beside the other private flags:

```ts
  private txPayeesStarted = false;
```

At the end of `deltaSync()`'s `try` block (after the `for` loop over tables, before `finally`):

```ts
      // Only after a full successful sync — matching against a half-populated replica would copy
      // from incomplete history. start() is idempotent, but the flag keeps reconnect syncs quiet.
      if (!this.txPayeesStarted) {
        this.txPayeesStarted = true;
        this.txPayees.start();
      }
```

- [ ] **Step 3: Enqueue newly-unmapped rows from the notify path**

In `onNotification`, inside the non-delete branch after the SQLite upsert:

```ts
        // A new or changed transaction with no payee is work for tx-payees. Matched rows come back
        // through this same path with payee_id set, so this cannot loop.
        if (evt.table === 'bank_tx' && (row as { payeeId: string | null }).payeeId == null) {
          this.txPayees.enqueue(evt.id);
        }
```

- [ ] **Step 4: Typecheck and run**

```bash
pnpm -C projects/ai-agent run typecheck
set -a && . ./.env.local && set +a && timeout 60 pnpm -C projects/ai-agent start 2>&1 | head -40
```

Expected: after the four `sync …` lines, a `backlog: 154 unmapped transactions since 2026-01-01`
line. With `matching_rule` still empty, only exact matches resolve.

- [ ] **Step 5: Verify writes landed**

```bash
set -a && . ./.env.local && set +a
psql "$DATABASE_URL" -c "
SELECT count(*) FILTER (WHERE payee_id IS NULL) AS still_unmapped,
       count(*) FILTER (WHERE payee_id IS NOT NULL) AS mapped
FROM bank_tx WHERE date >= '2026-01-01' AND transfer_bank_account_id IS NULL AND NOT reconcile;"
```

Expected: `still_unmapped` lower than the 154 baseline.

- [ ] **Step 6: Commit**

```bash
git add projects/ai-agent/src
git commit -m "feat(ai-agent): start tx-payees after first sync; enqueue on notify"
```

---

### Task 9: Seed the 21 matching rules

**Files:**
- Create: `projects/ai-agent/src/tx-payees/seed-matching-rules.ts`
- Modify: `projects/ai-agent/package.json` (add the script)

- [ ] **Step 1: Write the seed script**

Create `projects/ai-agent/src/tx-payees/seed-matching-rules.ts`:

```ts
// Seeds matching_rule with the merchant patterns ported from scrape-txs'
// backfill-mappings-by-description.ts MATCHERS, preserving their array order as `priority` (first
// match wins). Patterns are JS regex SOURCES — no delimiters, no flags; the `i` flag is applied by
// the regexp() function registered in ReplicaDb. Idempotent: upserts on `label`.
//
// Run (from repo root, with .env.local sourced):
//   pnpm -C projects/ai-agent run seed-matching-rules
import { db, matchingRule, pool, sql } from '@bank-bots/db';

const PATTERNS: [label: string, pattern: string][] = [
  ['san martin', String.raw`\bsan martin\b`],
  ['cpx', String.raw`\bcpx\b`],
  ['spotify', String.raw`\bspotify\b`],
  ['seguros el_a', String.raw`\bSEGUROS EL_A\b`],
  ['volaris', String.raw`\bvolaris\b`],
  ['farmacia galeno', String.raw`\bfarmacia galeno\b`],
  ['amazon', String.raw`\bamazon(\.com|\sMKTPL)\b`],
  ['starbucks', String.raw`\bstarbucks\b`],
  ['i/t transfer', String.raw`\bI\/T-\d+ I000\d+\b`],
  ['pago tarjeta', String.raw`\bPAGO TARJETA\b`],
  ['uber', String.raw`\buber.+(trip|rides)\b`],
  ['mcdonalds', String.raw`\bmcdonalds\b`],
  ['pollo campero', String.raw`\bpollo campero\b`],
  ['cafe barista', String.raw`\bcafe barista\b`],
  ['cemaco', String.raw`\bcemaco\b`],
  ['pedidosya propina', String.raw`\bpedidos\s*ya\s+propina`],
  ['pedidosya super', String.raw`\bpedidos\s*ya\s+(?:super|s[úu]per)`],
  ['pedidosya plus', String.raw`\bpedidos\s*ya\s+plus`],
  ['pedidosya', String.raw`\bpedidos\s*ya\b(?!\s+(?:propina|super|s[úu]per|plus))`],
  ['disney', String.raw`\bdisney\b`],
  ['tigo', String.raw`\btigo\b`],
];

async function main() {
  // Fail fast on a pattern that isn't a valid JS regex, before any of them reach the DB.
  for (const [label, pattern] of PATTERNS) new RegExp(pattern, 'i');

  for (const [i, [label, pattern]] of PATTERNS.entries()) {
    await db
      .insert(matchingRule)
      .values({ label, pattern, priority: (i + 1) * 10, enabled: true })
      .onConflictDoUpdate({
        target: matchingRule.label,
        set: { pattern: sql`excluded.pattern`, priority: sql`excluded.priority` },
      });
  }
  console.log(`seeded ${PATTERNS.length} matching rules`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
```

- [ ] **Step 2: Confirm the unique index exists**

The seed's `onConflictDoUpdate` targets `label`, which needs a unique constraint — created in
Task 4 Step 1 as `matching_rule_label_unique`.

```bash
set -a && . ./.env.local && set +a
psql "$DATABASE_URL" -c "\d matching_rule" | grep -i unique
```

Expected: a line naming `matching_rule_label_unique`. If absent, Task 4 Step 1 used the
single-argument `pgTable` form — add the index there and re-run `db:generate` + `db:migrate`.

- [ ] **Step 3: Add the package script**

In `projects/ai-agent/package.json` `scripts`:

```json
    "seed-matching-rules": "node --import @swc-node/register/esm-register src/tx-payees/seed-matching-rules.ts",
```

- [ ] **Step 4: Seed and verify**

```bash
set -a && . ./.env.local && set +a
pnpm -C projects/ai-agent run seed-matching-rules
psql "$DATABASE_URL" -c "SELECT count(*) FROM matching_rule;"
pnpm -C projects/ai-agent run seed-matching-rules   # idempotency check
psql "$DATABASE_URL" -c "SELECT count(*) FROM matching_rule;"
```

Expected: 21 both times.

- [ ] **Step 5: Run the agent and confirm regex matches fire**

```bash
set -a && . ./.env.local && set +a && timeout 60 pnpm -C projects/ai-agent start 2>&1 | grep -E "backlog|regex:|exact:" | head -20
```

Expected: `regex:<label>` lines alongside exact matches.

- [ ] **Step 6: Commit**

```bash
git add projects/ai-agent projects/db
git commit -m "feat(ai-agent): seed matching rules from the legacy matcher list"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `projects/ai-agent/CLAUDE.md`

- [ ] **Step 1: Update the root `CLAUDE.md`**

In the schema section: change the `bank_tx.id` row to `uuid | primary key (uuidv7, app-generated)`;
add the `reconcile` row; add a `matching_rule` table subsection; record the convention —

> **Every new table gets a uuidv7 primary key**, generated app-side via
> `uuid().primaryKey().$defaultFn(uuidv7)` (PG 15 has no `uuidv7()`). Exception: `payee`,
> `category`, `category_group` keep the YNAB uuids they were imported with.

Add `pnpm -C projects/ai-agent run seed-matching-rules` to the "Running things" section, and note
that reconciliation rows are identified by `bank_tx.reconcile`, not `doc_no`.

- [ ] **Step 2: Update `projects/ai-agent/CLAUDE.md`**

Add a section describing `replica-db/` vs `replica-sync/` vs `tx-payees/`, the startup ordering
(sync completes → `txPayees.start()`), and the registered `regexp()` function.

- [ ] **Step 3: Full verification sweep**

```bash
pnpm -C projects/db run typecheck
pnpm -C projects/scrape-txs run typecheck
pnpm -C projects/ai-agent run typecheck
pnpm -C projects/ai-agent test
( cd projects/update-ynab && go build ./... )
```

Expected: all clean (the Go build is unaffected legacy code).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md projects/ai-agent/CLAUDE.md
git commit -m "docs: uuidv7 convention, reconcile flag, tx-payees module"
```
