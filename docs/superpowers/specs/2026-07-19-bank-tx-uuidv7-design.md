# bank_tx uuidv7 primary key + uuidv7 PK convention

**Date:** 2026-07-19
**Status:** approved, ready for implementation plan
**Sequencing:** lands **before** [tx-payees](./2026-07-19-tx-payees-design.md), which types transaction ids.

## Goal

Convert `bank_tx.id` from `bigint` identity to a `uuid` holding a **uuidv7**, and adopt uuidv7 as the
primary-key convention for every new table.

## Rationale

`bank_account.id` is already uuidv7 (`uuid().primaryKey().$defaultFn(uuidv7)`), so `bank_tx` is the
outlier. Converting it makes the schema uniform and matches the convention below.

What the change buys:

- **Consistency** with `bank_account` and with every table added from here on.
- **App-side id generation** — a row's id is known before insert, with no round-trip and no sequence.
- Ids that do not leak row counts.

What it does **not** buy, recorded so the rationale isn't misremembered:

- **It does not add historic ordering.** `generatedByDefaultAsIdentity()` already increases
  monotonically with insertion, which is the same ordering uuidv7 provides. Ordering is preserved,
  not gained.
- **It does not give transaction-date chronology.** 3145 rows share a `created_at` of 2026-07-16
  from the YNAB history ingest while spanning transaction dates from 2022 to 2026. Sorting by id
  yields ingest order, not transaction history. Transaction chronology is `ORDER BY date`, under any
  id scheme.

## Convention (new)

> Every new table gets a **uuidv7 primary key**, generated app-side via
> `uuid().primaryKey().$defaultFn(uuidv7)`. Postgres 15 has no `uuidv7()` function, so generation is
> always in application code.

Exception, retained: `payee`, `category`, and `category_group` keep the YNAB uuids they were imported
with. Those are foreign identifiers, not ids we mint.

This convention goes into `CLAUDE.md` under the schema section, which already documents id choices.
`matching_rule` in the tx-payees spec already conforms.

## Backfill strategy — option C

Existing ids are regenerated at migration time, **in old-id order**. The v7 timestamp component
therefore encodes *when the migration ran*, not when the row was created; only the relative ordering
of existing rows is meaningful. Rows inserted after the migration carry real creation timestamps.

Options B (timestamp from `date`) and A (timestamp from `created_at`) were considered and rejected in
favor of C's simplicity. The consequence to accept: for the 6786 pre-migration rows, the embedded
timestamp is not a creation time. Global ordering still holds — the migration block sorts before
everything inserted afterwards.

### Ordering is guaranteed

A naive concern with C is that generating thousands of v7s inside one millisecond would leave
ordering to the random tail. `uuid@14`'s v7 is monotonic within a process; verified empirically:

```
generated: 6786
distinct ms prefixes: 11
order inversions: 0
strictly increasing: true
```

So a sequential loop over rows in old-id order produces strictly increasing uuids with no synthetic
timestamp spreading. If the backfill is done in pure SQL instead (below), ordering is guaranteed
structurally rather than by the library.

## Migration `0008`

**No inbound foreign keys reference `bank_tx.id`** — verified against `pg_constraint`. All four of
`bank_tx`'s FKs are outbound (`bank_account` ×2, `payee`, `category`). The primary-key swap therefore
touches no other table and needs no cascading rewrite.

```sql
ALTER TABLE bank_tx ADD COLUMN id_new uuid;

-- Populate in old-id order. ms = base + row_number gives one millisecond per row (~6.8s of span for
-- 6786 rows), so ordering is structural and independent of the random tail.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY id) AS rn FROM bank_tx
)
UPDATE bank_tx t SET id_new = uuidv7_at(
  (extract(epoch FROM now()) * 1000)::bigint - (SELECT count(*) FROM bank_tx) + o.rn
)
FROM ordered o WHERE o.id = t.id;

ALTER TABLE bank_tx ALTER COLUMN id_new SET NOT NULL;
ALTER TABLE bank_tx DROP CONSTRAINT bank_tx_pkey;
ALTER TABLE bank_tx DROP COLUMN id;
ALTER TABLE bank_tx RENAME COLUMN id_new TO id;
ALTER TABLE bank_tx ADD PRIMARY KEY (id);
```

`uuidv7_at(ms bigint)` is a small `plpgsql` helper defined in the same migration: 48-bit millisecond
timestamp, version nibble `7`, variant bits `10`, random remainder. It is dropped at the end of the
migration — it exists only for the backfill, since ids are generated app-side from here on.

Hand-authoring is required regardless: `db:generate` cannot model a primary-key type change, and per
`CLAUDE.md` it needs a TTY for rename resolution. Follow the `0003_finalize_bank_tx` pattern —
hand-write the `.sql`, transform the previous `meta/NNNN_snapshot.json`, then validate by re-running
`db:generate` and expecting "No schema changes".

The unique index `bank_tx_unique_cols` on `(bank_account_id, date, doc_no, description, amount_cents)`
is untouched — it does not include `id`.

**Alternative if the plpgsql helper proves awkward:** a one-shot TS script between two migrations,
generating ids with `uuid@14`'s v7 in `ORDER BY id` sequence (monotonicity verified above). Slightly
more moving parts; same result.

## Code changes

| File | Change |
| --- | --- |
| `projects/db/src/schema.ts:77` | `bigint({mode:'number'}).primaryKey().generatedByDefaultAsIdentity()` → `uuid().primaryKey().$defaultFn(uuidv7)` |
| `projects/ai-agent/src/replica-db/replica-schema.ts` | `bankTx.id`: `integer('id')` → `text('id')`; same in `CREATE_SCHEMA_SQL`; bump `EXPECTED_SCHEMA_VERSION` |
| `projects/ai-agent/src/replica-sync/replica-sync.service.ts:53` | `castId: (id) => Number(id)` → `(id) => id`; update the comment at line 30 |
| `projects/scrape-txs/src/scripts/backfill-mappings-by-description.ts` | `Row.id: number` → `string`; `${u.id}::bigint` → `::uuid` in the `VALUES` upsert |
| `projects/scrape-txs/src/scripts/backfill-ynab-mappings.ts:25` | `id: number` → `string`; the two `VALUES` casts likewise |
| `projects/ai-agent/src/tx-payees/*` | `Set<number>` → `Set<string>`; `enqueue(txId: string)` |
| `CLAUDE.md` | Record the uuidv7 PK convention; update the `bank_tx.id` row in the schema table |

The scrapers need three one-line changes: `deleteTxIds` is explicitly annotated `number[]` in
`lib/run.ts:32`, `lib/bac/scrape.ts:30`, and `lib/banco-industrial/scrape.ts:48`. The ids are
otherwise opaque — collected from query results and fed straight to `inArray`, never parsed or
compared numerically — so widening the annotation to `string[]` is the whole fix.

## Ordering assumptions to re-check

Both matcher tiers order by `date DESC, id DESC` as a tiebreaker. uuidv7 is lexicographically
ordered by its timestamp prefix, so text comparison preserves the intended "most recent first"
semantics. The backlog sweep's `created_at ASC, id ASC` holds for the same reason.

One nuance: within the migration block all ids sort by *old id*, which was insertion order — the same
ordering the tiebreaker previously had. No behavioral change.

## Replica impact

`EXPECTED_SCHEMA_VERSION` bumps, so the existing `storage/replica.sqlite` is dropped and rebuilt on
first boot — a full re-pull of all rows. That is the intended recovery path for a disposable cache,
and it is required here anyway: the `bank_tx.id` column changes SQLite type affinity from `INTEGER`
to `TEXT`.

## Verification

- `pnpm -C projects/db run typecheck`, `pnpm -C projects/scrape-txs run typecheck`,
  `pnpm -C projects/ai-agent run typecheck`
- Re-run `db:generate`; expect "No schema changes" against the hand-authored snapshot
- Row count unchanged at 6786; `count(DISTINCT id) = count(*)`
- New ids strictly increasing when ordered by the pre-migration id sequence
- Boot `ai-agent`; confirm the replica rebuilds and `bank_tx` row counts match Postgres
- Re-run the description backfill dry run; expect the same `760 targets / 0 matched` baseline

## Out of scope

- Converting `payee`/`category`/`category_group` ids. They are YNAB identifiers and stay as-is.
- Any change to `update-ynab` (legacy/retired, already targets a stale schema).
