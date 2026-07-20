# tx-ai-matcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Agent-SDK-backed third matching tier to `payee-resolver` that resolves the transactions exact-match and regex cannot, and record every match in a new `matcher_result` audit table.

**Architecture:** `TxMatcher.match()` becomes async and gains a third tier. The agent reads the SQLite replica through purpose-built read tools, may use `WebSearch`, and mutates Postgres through four narrow write tools. Every write awaits confirmation that `replica-sync` has landed the row locally, which preserves the feedback loop that `concurrency: 1` exists for.

**Tech Stack:** NestJS 12 (alpha), native ESM, `@anthropic-ai/claude-agent-sdk`, Zod, Drizzle (Postgres + better-sqlite3), p-queue, emittery, node:test.

**Spec:** `docs/superpowers/specs/2026-07-19-tx-ai-matcher-design.md`

## Global Constraints

- **Do not commit.** The owner is code-reviewing; leave all work in the working tree.
- Model is `claude-sonnet-5`, effort `medium`, both set explicitly.
- Auth via `CLAUDE_CODE_OAUTH_TOKEN`. Never log or print it.
- New tables and rows we mint get **uuidv7** primary keys, generated app-side via `uuidv7()`.
- `payee` / `category` / `category_group` ids imported from YNAB keep their YNAB uuids; new ones we create are uuidv7. Both are 36-char text.
- Zod → JSON Schema must use `z.toJSONSchema(schema, { target: 'draft-7' })`; the SDK is draft-07.
- Agent options must include `tools: ['WebSearch']` and `settingSources: []`.
- Scripts are `.ts`. No AI attribution anywhere.
- `pnpm -C projects/tx-payees test` and `pnpm -C projects/tx-payees run typecheck` must pass at the end of every task.

---

### Task 1: Replace `new-tx` with `row-persisted`

**Files:**
- Modify: `projects/tx-payees/src/events/app-events.ts`
- Modify: `projects/tx-payees/src/replica-sync/replica-sync.service.ts`
- Modify: `projects/tx-payees/src/payee-resolver/payee-resolver.service.ts`

**Interfaces:**
- Produces: `AppEventData['replica-sync.row-persisted'] = { table: string; op: 'insert' | 'update' | 'delete'; id: string }`

- [ ] **Step 1: Change the event map**

In `app-events.ts`, replace the `replica-sync.new-tx` entry:

```ts
export interface AppEventData {
  'replica-sync.startup-sync-finished': undefined;
  /** A row was applied to the local replica. Emitted after the SQLite write, so a listener that
   *  observes it can rely on the replica already reflecting the row. */
  'replica-sync.row-persisted': { table: string; op: 'insert' | 'update' | 'delete'; id: string };
}
```

- [ ] **Step 2: Emit it from replica-sync**

In `replica-sync.service.ts` `onNotification`, emit after the delete and after the upsert, replacing the `new-tx` emit:

```ts
if (evt.op === 'delete') {
  this.replica.db.delete(t.lite).where(eq(t.lite.id, id)).run();
  void this.events.emit('replica-sync.row-persisted', { table: evt.table, op: 'delete', id });
} else {
  const [row] = await pgDb.select().from(t.pg).where(pgEq(t.pg.id, id));
  if (!row) return;
  this.replica.db.insert(t.lite).values(row)
    .onConflictDoUpdate({ target: t.lite.id, set: this.excludedSet(t.lite) }).run();
  void this.events.emit('replica-sync.row-persisted', {
    table: evt.table,
    op: evt.op === 'insert' ? 'insert' : 'update',
    id,
  });
}
```

- [ ] **Step 3: Move the insert-only filter to the consumer**

In `payee-resolver.service.ts` `onModuleInit`:

```ts
this.events.on('replica-sync.row-persisted', ({ data }) => {
  // insert-only: an update to a still-unmapped row (a re-scrape changing amount_cents) shouldn't
  // re-queue it — the next startup sweep picks it up.
  if (data.table !== 'bank_tx' || data.op !== 'insert') return;
  this.onNewTx(data.id);
}),
```

- [ ] **Step 4: Verify**

```bash
pnpm -C projects/tx-payees run typecheck && pnpm -C projects/tx-payees test
grep -rn "new-tx" projects/tx-payees/src   # expect no matches
```

---

### Task 2: `matcher_result` table, migration, replication

**Files:**
- Modify: `projects/db/src/schema.ts`, `projects/db/src/index.ts`
- Create: `projects/db/drizzle/0010_matcher_result.sql`
- Modify: `projects/tx-payees/src/replica-db/replica-schema.ts`, `replica-db.service.ts`, `replica-sync.service.ts`

**Interfaces:**
- Produces: `matcherResult` Drizzle table exported from `@bank-bots/db` and from the replica schema.

- [ ] **Step 1: Add the Postgres table**

```ts
export const matcherResult = pgTable('matcher_result', {
  id: uuid().primaryKey().$defaultFn(uuidv7),
  bankTxId: uuid('bank_tx_id').notNull().references(() => bankTx.id, { onDelete: 'cascade' }),
  type: text().notNull(),
  payeeId: text('payee_id').references(() => payee.id),
  categoryId: text('category_id').references(() => category.id),
  sourceTxId: uuid('source_tx_id').references(() => bankTx.id),
  matchingRuleId: uuid('matching_rule_id').references(() => matchingRule.id),
  data: jsonb(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [index('matcher_result_bank_tx_id_idx').on(table.bankTxId)]);
```

Export it from `projects/db/src/index.ts`.

- [ ] **Step 2: Hand-author the migration**

`db:generate` needs a TTY, so write `projects/db/drizzle/0010_matcher_result.sql` by hand with the `CREATE TABLE`, the FKs, the index, and both triggers (`trg_set_updated_at`, `trg_replica_notify`) matching `0009`. Append its entry to `drizzle/meta/_journal.json`.

- [ ] **Step 3: Apply it**

```bash
set -a; . ./.env.local; set +a; pnpm -C projects/db db:migrate
```

- [ ] **Step 4: Mirror in the replica**

Add the SQLite table to `replica-schema.ts` (text ids, `data` as `text` holding JSON), add it to the `CREATE TABLE IF NOT EXISTS` DDL, bump `EXPECTED_SCHEMA_VERSION` to `2`, and append `{ name: 'matcher_result', pg: pgMatcherResult, lite: liteMatcherResult }` to `ReplicaSync.tables` **after** `bank_tx` (it references it).

- [ ] **Step 5: Verify**

```bash
pnpm -C projects/db run typecheck && pnpm -C projects/tx-payees run typecheck
set -a; . ./.env.local; set +a; psql "$DATABASE_URL" -c '\d matcher_result'
```

---

### Task 3: `ReplicaSettled`

**Files:**
- Create: `projects/tx-payees/src/events/replica-settled.service.ts`
- Create: `projects/tx-payees/src/events/replica-settled.service.test.ts`
- Modify: `projects/tx-payees/src/events/events.module.ts`

**Interfaces:**
- Produces: `ReplicaSettled.around<T>(table: string, id: string, write: () => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing tests**

```ts
test('resolves when the matching row-persisted event fires', async () => {
  const events = new AppEvents();
  const settled = new ReplicaSettled(events);
  const out = await settled.around('payee', 'p1', async () => {
    setTimeout(() => void events.emit('replica-sync.row-persisted',
      { table: 'payee', op: 'insert', id: 'p1' }), 5);
    return 'ok';
  });
  assert.equal(out, 'ok');
});

test('ignores events for a different table or id', async () => { /* emit payee/p2 then payee/p1 */ });
test('resolves on timeout instead of throwing', async () => { /* never emit; assert it returns */ });
test('listens before the write runs', async () => {
  // emit synchronously from inside the write callback; it must still be observed
});
```

- [ ] **Step 2: Run them, expect failure** — `pnpm -C projects/tx-payees test` fails with "Cannot find module".

- [ ] **Step 3: Implement**

```ts
@Injectable()
export class ReplicaSettled {
  private readonly logger = new Logger(ReplicaSettled.name);
  private readonly timeoutMs = Number(process.env.TX_AI_SETTLE_TIMEOUT_MS ?? 2000);

  constructor(private readonly events: AppEvents) {}

  /**
   * Run `write`, then wait until replica-sync confirms the row reached SQLite.
   * The listener is registered BEFORE the write so a fast notification can't be missed —
   * passing the write as a callback makes that ordering impossible to invert at a call site.
   */
  async around<T>(table: string, id: string, write: () => Promise<T>): Promise<T> {
    let settle!: () => void;
    const landed = new Promise<void>((resolve) => { settle = resolve; });
    const off = this.events.on('replica-sync.row-persisted', ({ data }) => {
      if (data.table === table && data.id === id) settle();
    });
    try {
      const result = await write();
      await Promise.race([landed, this.timeout(table, id)]);
      return result;
    } finally {
      off();
    }
  }

  private timeout(table: string, id: string): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(() => {
        this.logger.warn(`replica did not confirm ${table}#${id} in ${this.timeoutMs}ms; continuing`);
        resolve();
      }, this.timeoutMs).unref(),
    );
  }
}
```

Provide and export it from `EventsModule` (already `@Global`).

- [ ] **Step 4: Run the tests, expect pass.**

---

### Task 4: `matcher_result` persistence + `none` skip

**Files:**
- Create: `projects/tx-payees/src/payee-resolver/matcher-result.service.ts`
- Modify: `projects/tx-payees/src/payee-resolver/tx-matcher.service.ts`
- Modify: `projects/tx-payees/src/payee-resolver/payee-resolver.service.ts`
- Modify: `projects/tx-payees/src/payee-resolver/tx-matcher.service.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type MatchOutcome =
    | { type: 'exact' | 'rule'; payeeId: string; categoryId: string; sourceTxId: string; ruleId?: string }
    | { type: 'ai'; payeeId: string; categoryId: string; data: MatcherData }
    | { type: 'none'; data?: MatcherData };
  ```

- [ ] **Step 1: Change `match()` to return an outcome**

`match()` becomes `async` and always returns a `MatchOutcome`, carrying `sourceTxId` for tier 1 and `sourceTxId` + `ruleId` for tier 2. `mostRecentMapped` also selects `bankTx.id` so the source is known.

- [ ] **Step 2: Update the 9 existing tests**

Add `await`, assert on `outcome.type` rather than a nullable result, and construct `TxMatcher` with a stub AI matcher whose `resolve()` returns `{ type: 'none' }`. This proves tiers 1 and 2 are unchanged.

- [ ] **Step 3: Persist from `PayeeResolver.process`**

After the Postgres `bank_tx` update (wrapped in `settle.around('bank_tx', txId, …)`), insert one `matcher_result` row. Persist `none` verdicts too — they are the skip signal.

- [ ] **Step 4: Skip terminal `none` in the backlog**

Add to `start()`'s `where`:

```ts
notExists(
  this.replica.db.select({ one: sql`1` }).from(matcherResult)
    .where(and(eq(matcherResult.bankTxId, bankTx.id), eq(matcherResult.type, 'none'))),
),
```

- [ ] **Step 5: Add the skip test and the feedback-loop test**

Feedback-loop test: queue two transactions with identical descriptions; the stub AI resolves the first by creating a payee and fails the test if invoked a second time. Assert the second resolves via `exact` and that exactly one payee exists.

- [ ] **Step 6: Verify** — `pnpm -C projects/tx-payees test` and `run typecheck`.

---

### Task 5: Read tools

**Files:**
- Create: `projects/tx-payees/src/payee-resolver/ai/read-tools.ts`
- Create: `projects/tx-payees/src/payee-resolver/ai/read-tools.test.ts`

**Interfaces:**
- Produces: `buildReadTools(replica: ReplicaDb): SdkMcpToolDefinition[]` and `testRegex(replica, pattern): RegexReport`

- [ ] **Step 1: Write failing tests for `testRegex`** — agreement counts, unmapped counts, overlap with existing rules, invalid pattern rejected, catastrophic backtracking rejected (budget exceeded), over-broad rejected (>30% of mapped descriptions).

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement the four tools**

`find_similar_transactions`, `search_payees` (returning id, name, tx count, and the distinct trailing 2-letter country tokens of its transactions), `list_matching_rules`, `test_regex`. All `readOnlyHint: true`. `test_regex` returns `{ ok, reason?, mapped: { total, byPayee }, unmappedWouldCatch, samples, overlappingRules }`.

- [ ] **Step 4: Run tests, expect pass.**

---

### Task 6: Write tools

**Files:**
- Create: `projects/tx-payees/src/payee-resolver/ai/write-tools.ts`
- Create: `projects/tx-payees/src/payee-resolver/ai/write-tools.test.ts`

**Interfaces:**
- Produces: `buildWriteTools(deps): { tools: SdkMcpToolDefinition[]; sideEffects: SideEffects }`

- [ ] **Step 1: Write failing tests** — uuidv7 minted for new rows; `create_category` rejects an unknown `groupId`; `create_matching_rule` rejects an uncompilable pattern, a catastrophically slow one, and an over-broad one; side effects are recorded.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

Four tools, each `await settle.around(table, id, () => pgDb…)`. Rule-writing tools call the same `testRegex` safety path from Task 5 and return `isError: true` with the reason on rejection. Every successful write appends to a per-run `SideEffects` record — the ground truth for `matcher_result.data`.

- [ ] **Step 4: Run tests, expect pass.**

---

### Task 7: `TxAiMatcher` + prompt + third tier

**Files:**
- Create: `projects/tx-payees/src/payee-resolver/ai/prompt.ts`
- Create: `projects/tx-payees/src/payee-resolver/ai/output-schema.ts`
- Create: `projects/tx-payees/src/payee-resolver/tx-ai-matcher.service.ts`
- Modify: `projects/tx-payees/src/payee-resolver/tx-matcher.service.ts`, `payee-resolver.module.ts`, `package.json`

**Interfaces:**
- Consumes: `buildReadTools`, `buildWriteTools`, `ReplicaSettled`
- Produces: `TxAiMatcher.resolve(tx: MatchableTx): Promise<MatchOutcome>`

- [ ] **Step 1: Install the SDK**

```bash
pnpm -C projects/tx-payees add @anthropic-ai/claude-agent-sdk zod
```

- [ ] **Step 2: Write the system prompt**

Copy the prompt verbatim from the spec's "System prompt" block into `prompt.ts` as `SYSTEM_PROMPT`, plus `buildCategoryList(replica)` which appends the active categories (name, group, id) read from the replica, and `buildUserPrompt(tx)` carrying description (padding preserved), length, date, `amount_cents`, currency, bank key, account number.

- [ ] **Step 3: Define the output schema**

```ts
export const Answer = z.object({
  matched: z.boolean(),
  payeeId: z.string().nullable(),
  categoryId: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string(),
});
export const answerJsonSchema = z.toJSONSchema(Answer, { target: 'draft-7' });
```

- [ ] **Step 4: Implement `TxAiMatcher.resolve`**

Build the in-process MCP server from the read + write tools, run `query()` with the options from the spec, iterate to the `result` message, and validate: `subtype === 'success'` with `structured_output` present, `matched === true` requiring both ids to resolve to real rows. A self-contradictory answer is a **failed run** (throws) — not a `none` verdict. Enforce `TX_AI_ENABLED`, `TX_AI_MAX_PER_SWEEP`, and `TX_AI_TIMEOUT_MS`.

- [ ] **Step 5: Wire as tier 3** in `TxMatcher.match()`, after the rule loop.

- [ ] **Step 6: Verify** — `pnpm -C projects/tx-payees test`, `run typecheck`, `pnpm eslint`.

---

### Task 8: Docs and live verification

**Files:**
- Modify: `projects/tx-payees/CLAUDE.md`, `CLAUDE.md`

- [ ] **Step 1: Update `projects/tx-payees/CLAUDE.md`** — third tier, tool surface, read/write split, `matcher_result`, manual-retry SQL, new env vars, `row-persisted` replacing `new-tx` in the event table, and correct the "inserts-only" rationale (the `payeeId` check prevents the loop, not the emitter's filter).

- [ ] **Step 2: Update root `CLAUDE.md`** — add `matcher_result`; fix the stale `bank_tx.amount numeric` row to `amount_cents bigint` and the unique index to `(bank_account_id, date, doc_no, description, amount_cents)`.

- [ ] **Step 3: Live run on one real transaction**

```bash
set -a; . ./.env.local; set +a
TX_AI_MAX_PER_SWEEP=1 pnpm -C projects/tx-payees start
```

Inspect the resulting `matcher_result` row and any created payee/rule before leaving the tier enabled.

- [ ] **Step 4: Leave everything uncommitted for review.**
