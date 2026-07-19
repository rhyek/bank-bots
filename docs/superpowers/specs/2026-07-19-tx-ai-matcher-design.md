# tx-ai-matcher — AI last-resort payee/category resolution

**Date:** 2026-07-19
**Component:** `projects/tx-payees` (`payee-resolver` module)
**Status:** approved, ready for planning

## Problem

The two-tier matcher (exact description, then `matching_rule` regex) resolves ~82% of
transactions. Measured on 2026-07-19 against 874 transactions dated on/after 2026-01-01:

| Bucket | Count | Why the current matcher fails |
| --- | --- | --- |
| Merchant, history already has it | 68 | description drifted (`AVIANCA  PA` vs the mapped `AVIANCA        PANAM`) |
| Merchant, no history at all | 65 | nothing to copy from (`PLAYSTATION`, `1PASSWORD`, `CLOUDFLARE`) |
| Transfers | 17 | not payee work — belongs in `transfer_bank_account_id` |
| Bank fees / interest | 4 | no mapped precedent |
| **Total unmapped** | **154** | |

Both merchant buckets need judgment the two existing tiers cannot express: recognizing that a
description drifted, that a suffix is a random identifier, that a country code means a *different*
payee, or that an unknown string is a real business with an obvious category.

## Goal

Add a third tier — an agent built on the **Claude Agent SDK** — that runs only after exact and
regex both miss. It reads the SQLite replica, may search the web, and can create the payees,
categories, and matching rules its answer requires. Every match, from every tier, is recorded in a
new `matcher_result` table.

## Non-goals

- **Transfers.** Populating `transfer_bank_account_id` is out of scope. The agent returns "no match"
  for transfer-shaped rows; the `none` verdict stops them being retried. A future spec can add a
  transfer tier that runs *before* the AI tier.
- **Re-mapping already-mapped transactions.** The agent only ever sees rows with `payee_id IS NULL`.
- **Backfilling `matcher_result` for historical matches.** The table starts empty and accumulates
  going forward.

## Architecture

`TxMatcher.match()` becomes `async` and gains a third tier. It always returns an outcome object —
never a bare `null` — so a "no match" carries the agent's reasoning and can be persisted.

```
PayeeResolver.process(txId)
  └─ await TxMatcher.match(tx)
       ├─ tier 1  exact description   → { type:'exact', payeeId, categoryId, sourceTxId }
       ├─ tier 2  matching_rule regex → { type:'rule',  payeeId, categoryId, sourceTxId, ruleId }
       └─ tier 3  await TxAiMatcher   → { type:'ai',   payeeId, categoryId, data }
                                      │  { type:'none', data }
  ├─ persist one matcher_result row
  └─ if resolved → UPDATE bank_tx SET payee_id, category_id  (Postgres)
```

### Where writes go

The agent **reads** the SQLite replica and **writes** to Postgres, through purpose-built tools.

This split is load-bearing. `replica.sqlite` is a disposable cache: `ReplicaDb` drops and rebuilds
the entire file whenever `EXPECTED_SCHEMA_VERSION` changes, and delta sync overwrites rows from
Postgres continuously. Anything written to SQLite would be destroyed. Postgres is the source of
truth, so every mutation lands there and flows back to the replica via the existing
`trg_replica_notify` trigger.

The agent never receives a general database handle. Each write is a single named operation with its
own Zod schema, validated in our code, with ids minted by us.

### Sequential matching is a feedback loop, not just serialization

`concurrency: 1` exists so that **each resolved transaction becomes history the next one can use**.
The backlog compounds as it drains: resolving `PLAYSTATION 650-2` once should make the other six
occurrences free.

That property does not survive the Postgres-write / SQLite-read split on its own. The tiers read the
replica, but matches are written to Postgres and only reach the replica via `trg_replica_notify` →
`replica-sync`. The race is lost by default:

```
job N   : await pgDb.update(bank_tx)   -- returns in ~1 ms
          process() returns
job N+1 : exact-tier SELECT on SQLite  -- runs immediately, before the notification lands
```

For tiers 1 and 2 this was harmless, which is why it went unnoticed: an exact match copies from some
source row S that is already in the replica, so the next transaction finds S directly whether or not
its predecessor replicated. A tier-1/2 match adds no information that did not already exist.

**The AI tier breaks that.** It creates new payees, categories, and rules — genuinely new
information. Without write-through the failure is not merely a wasted agent call:

> tx N `PLAYSTATION 650-2` → agent finds no payee, creates "PlayStation".
> tx N+1 `PLAYSTATION 650-2` → exact misses (stale replica), regex misses, agent reruns,
> `search_payees` still reads the stale replica → **creates a second "PlayStation" payee.**

**Resolution: await replication.** After writing to Postgres, the writer waits until `replica-sync`
confirms the row has landed in SQLite, then continues. `replica-sync` remains the **only** writer to
the replica.

`replica-sync` emits one event in `onNotification`, after the upsert or delete has been applied —
the point at which the replica provably reflects the row:

```ts
'replica-sync.row-persisted': { table: string; op: 'insert' | 'update' | 'delete'; id: string };
```

**This replaces `replica-sync.new-tx`, which is removed.** `new-tx` was a strict subset of
`row-persisted` (`bank_tx` + `insert`), and it encoded a *consumer's* interpretation — "there is
fresh work" — inside a module that is supposed to know nothing about payee-resolver. `row-persisted`
is a pure replication fact; each consumer decides what it means. That is the layering the
event-decoupling was for.

The insert-only filter moves to the consumer and must stay explicit:

```ts
this.events.on('replica-sync.row-persisted', ({ data }) => {
  // insert-only: an update to a still-unmapped row (a re-scrape changing amount_cents)
  // shouldn't re-queue it — the next startup sweep picks it up.
  if (data.table !== 'bank_tx' || data.op !== 'insert') return;
  this.onNewTx(data.id);
});
```

> **Correction to the earlier rationale.** `projects/tx-payees/CLAUDE.md` currently claims
> inserts-only makes the payee-write feedback loop "structurally impossible". That overstates the
> emitter's role. The loop protection is the `payeeId != null` check in `onNewTx` — our own writes set
> a payee, so they are skipped whichever event carries them. Inserts-only prevents something
> narrower: re-queueing a still-unmatched row when an unrelated field changes. Real, but churn, not a
> loop. The doc is corrected as part of this work.

A small `ReplicaSettled` helper wraps the pattern, and its shape enforces the ordering:

```ts
// Registers the one-off listener BEFORE running the write, then awaits confirmation.
await settle.around('payee', id, () => pgDb.insert(pgPayee).values(row));
```

Registering after the write is the one way to get this wrong: the notification can land in the gap,
the listener never fires, and every write pays the full timeout. Passing the write as a callback makes
that ordering impossible to invert at a call site. Ids are minted app-side, so the id is always known
before the write.

Applied at each write site, not batched at the end of the job:

| Write | Awaits |
| --- | --- |
| `bank_tx.payee_id` / `category_id` | `('bank_tx', txId)` |
| `create_payee` | `('payee', id)` |
| `create_category` | `('category', id)` |
| `create_matching_rule` / `update_matching_rule` | `('matching_rule', id)` |

Per-site rather than per-job because it also fixes intra-run staleness: if `create_payee` does not
return until the payee is locally visible, the agent's own later `search_payees` call in the same run
sees it too.

**On timeout** (`TX_AI_SETTLE_TIMEOUT_MS`, default 2000): log a warning and proceed. The Postgres
write has already succeeded — that is the source of truth — so a missed confirmation degrades to
exactly the pre-existing behavior and the next sweep self-corrects. A settle timeout must never fail
the job.

**Rejected alternative: write-through** (applying each change to SQLite ourselves in the same code
path). It avoids the wait, but it duplicates `replica-sync`'s row mapping — the `Descriptor` tables
and `excludedSet()` upsert — in a second module, for four tables, where it would silently drift the
first time the replica schema changes. It also asserts the replica's contents rather than confirming
them. The added latency it saves is a few milliseconds against a 20–60 s agent run.

### New files

| Path | Responsibility |
| --- | --- |
| `payee-resolver/tx-ai-matcher.service.ts` | owns the Agent SDK `query()` call and its lifecycle |
| `payee-resolver/ai/read-tools.ts` | the four read tools (SQLite) |
| `payee-resolver/ai/write-tools.ts` | the four write tools (Postgres) + side-effect recording |
| `payee-resolver/ai/prompt.ts` | system prompt, domain heuristics, category list builder |
| `payee-resolver/ai/output-schema.ts` | Zod schema → JSON Schema for `outputFormat` |
| `payee-resolver/matcher-result.service.ts` | persists `matcher_result` rows |

Also new: `events/replica-settled.service.ts` — the `settle.around(table, id, write)` helper.

Modified: `tx-matcher.service.ts` (async + third tier + richer return type),
`payee-resolver.service.ts` (persist result, skip `none`, subscribe to `row-persisted` with an
explicit insert-only filter), `payee-resolver.module.ts` (new providers),
`events/app-events.ts` (**replace `new-tx` with `row-persisted`**),
`replica-sync.service.ts` (emit `row-persisted`; replicate `matcher_result`),
`replica-db/replica-schema.ts` (`matcher_result` + `EXPECTED_SCHEMA_VERSION` bump),
`projects/db/src/schema.ts` + a migration (the new table).

Replacing `new-tx` is a breaking change to code that already exists and works. It is a small,
self-contained refactor and should be its own task in the plan, verified green before the AI tier is
built on top of it.

## The Agent SDK integration

Package `@anthropic-ai/claude-agent-sdk` (0.3.215 at time of writing; bundles its own native
binary, `engines: node >=18`). Authentication is `CLAUDE_CODE_OAUTH_TOKEN`, generated by
`claude setup-token` and read from `.env.local`. It is a subscription-scoped credential — treat it
like a password and never log it.

### Query options

```ts
const result = query({
  prompt: buildPrompt(tx),
  options: {
    model: 'claude-sonnet-5',
    effort: 'medium',
    systemPrompt: SYSTEM_PROMPT,          // custom; NOT the claude_code preset
    settingSources: [],                    // do not inherit ~/.claude or repo CLAUDE.md
    tools: ['WebSearch'],                  // the ONLY built-in left in context
    mcpServers: { txp: txpServer },
    allowedTools: ['WebSearch', 'mcp__txp__*'],
    outputFormat: { type: 'json_schema', schema: z.toJSONSchema(Answer, { target: 'draft-7' }) },
    maxTurns: 25,
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
  },
});
```

Four of these are doing real work and must not be dropped:

- **`tools: ['WebSearch']`** removes every other built-in — `Bash`, `Read`, `Write`, `Edit`, `Glob`,
  `Grep` — from the agent's context entirely. Combined with the custom MCP tools, the agent's whole
  capability surface is the eight functions we wrote plus web search.
- **`settingSources: []`** stops the SDK loading `~/.claude` settings, project `.claude/`, and this
  repo's `CLAUDE.md`. Without it the agent's behavior would drift with the owner's dotfiles.
- **`effort: 'medium'`** is set explicitly rather than left to the default. The SDK has silently
  injected a flag-driven default before ([issue #214](https://github.com/anthropics/claude-agent-sdk-typescript/issues/214));
  an explicit value is immune to that.
- **`z.toJSONSchema(..., { target: 'draft-7' })`** — the SDK validates against JSON Schema draft-07
  while Zod emits 2020-12 by default. Omitting the target fails the run at startup.

### Reading the result

```ts
for await (const msg of result) {
  if (msg.type === 'result') {
    if (msg.subtype === 'success' && msg.structured_output) { /* use it */ }
    else { /* treat as failure — including success-with-no-output */ }
  }
}
```

A result with `subtype: 'success'` but no `structured_output` is a failure, as is
`error_max_structured_output_retries`. A single-shot `query()` also throws *after* yielding an error
result, so the loop is wrapped in `try/catch`.

## Tools

Names are `mcp__txp__<tool>` once registered under the server key `txp`.

### Read tools (SQLite replica, `readOnlyHint: true`)

| Tool | Input | Returns |
| --- | --- | --- |
| `find_similar_transactions` | `{ query, limit? }` | mapped history matching a token/substring: description, payee name, category name, most recent date, occurrence count |
| `search_payees` | `{ query, limit? }` | payee id + name (667 payees — too many to inline) |
| `list_matching_rules` | `{}` | id, label, pattern, priority, enabled for all rules |
| `test_regex` | `{ pattern }` | see below |

`readOnlyHint: true` lets the SDK run these in parallel.

The 63 active categories (94 total, 12 groups) are small enough to embed directly in the system
prompt, so no `list_categories` tool is needed — it saves a turn on every run.

### `test_regex`

The tool that makes autonomous rule creation defensible. Given a candidate pattern it reports,
against the real replica:

- whether the pattern compiles, and whether it is pathologically slow (see Safety below);
- how many **mapped** transactions it matches, and the distinct payees among them with counts —
  the agreement signal;
- how many **unmapped** transactions it would catch, with sample descriptions;
- which existing rules overlap it.

The agent is instructed to run this before proposing any rule, so it can distinguish "stable
merchant prefix" from "this suffix is a random identifier" using evidence rather than intuition.

### Write tools (Postgres)

| Tool | Input | Returns |
| --- | --- | --- |
| `create_payee` | `{ name }` | `{ id }` — uuidv7, minted by us |
| `create_category` | `{ name, groupId }` | `{ id }` — uuidv7; `groupId` must exist |
| `create_matching_rule` | `{ label, pattern, priority }` | `{ id }` — uuidv7 |
| `update_matching_rule` | `{ id, pattern?, priority?, enabled? }` | `{ id }` |

Each write tool records its side effect into a per-run context object. That record — not the
model's self-report — is what lands in `matcher_result.data.created` / `.updated`.

Each write tool also **awaits replication** before returning, via `ReplicaSettled`, so both the rest
of the agent's own run and the next transaction in the queue can see the new payee, category, or
rule. See "Sequential matching is a feedback loop" above for why this is required rather than an
optimization.

`create_category` requires an existing `category_group.id`; the agent can add a category, not
restructure the budget into new groups.

**Id convention.** New payees and categories get **uuidv7** ids, minted app-side, per the repo
convention. This makes `payee.id` heterogeneous — YNAB-imported rows keep their YNAB uuids, ours are
uuidv7. Both are 36-char text; nothing keys off the format. This is a deliberate, documented
consequence.

### Safety checks on rule patterns

Rules go live enabled with no correctness gate — that is the accepted design. But
`create_matching_rule` and `update_matching_rule` still reject a pattern that:

1. **fails to compile** as a JS regex;
2. **backtracks pathologically** — evaluated against a sample of real descriptions under a wall-clock
   budget (~50 ms); or
3. **matches an implausible share of all history** (> 30% of mapped descriptions).

These are liveness guards, not judgment calls. An accepted pattern runs against every description on
every future match, so a catastrophic regex would hang the matcher permanently and a
matches-everything pattern would mis-map the entire budget. A rejection is returned to the agent as
`isError: true` with the reason, so it can revise and retry.

## Prompt design

Derived from a full pass over the history on 2026-07-19: 6,025 mapped transactions across 505
payees, 21 existing rules, and the 154 unmapped rows. Every claim below is grounded in that data;
the findings that shaped it are recorded in "Evidence behind the prompt" at the end of this section.

### System prompt

````text
You classify a single bank transaction from a personal finance database. You decide which payee it
belongs to and which budget category it falls under, using the transaction history as evidence.

Your only data source is a local SQLite replica of the production database, reachable through the
tools below. You cannot run SQL directly and you cannot see the internet except through WebSearch.

## How to read a description

Descriptions come from Central American bank statements in fixed-width fields. Two shapes cover
most of them:

  25 chars = 22-char merchant field (space-padded) + " " + 2-letter ISO country
             "UBER *TRIP HELP.UBER.C NL"  ->  merchant "UBER *TRIP HELP.UBER.C", country NL

  30 chars = 25-char merchant field (space-padded) + 5-char city
             "CLARO MCE MPC CR         SAN J"  ->  merchant "CLARO MCE MPC CR", city "SAN J"

Two consequences matter:

1. Merchant names are TRUNCATED to fit the field. "RESTAURANTE SAN BERNARDIN" and
   "CENTRO ESPECIALIDADES DEN" are cut off mid-word. Never assume a name is complete.
2. The trailing country/city is a SEPARATE FIELD from the merchant name. Where a country code sits
   changes what it means — see "Country codes" below.

## Resolution procedure

Work in this order and stop as soon as you have high confidence.

### 1. Look for the same merchant in history

Use find_similar_transactions on the distinctive part of the merchant name. You are looking for a
mapped transaction that is the same merchant even though the string differs. Descriptions drift on
the vendor's side: an added word, a dropped suffix, a renamed processor, a different branch.

  "CINEPOLIS EC CS APP"  and  "CINEPOLIS EC CS APP CYBERSOURC"  are the same merchant.
  "SEGUROS EL ROBLE"     and  "SEGUROS EL ROBLE SOCIEDAD"       are the same merchant.

If you find one, that is your answer: copy BOTH its payee and its category. Then ask whether an
existing rule should have caught it. Run list_matching_rules and check. A rule that is too narrow
is a bug worth fixing — widening it resolves every future occurrence for free.

  Real example: the rule \bI\/T-\d+ I000\d+\b matched "I/T-012826 I000609536" for years. The bank's
  reference counter then rolled past I000999999 into "I/T-042926 I001012017", and the rule silently
  stopped matching. The fix is to widen I000\d+ to I\d+, not to add a second rule.

### 2. Decide whether the varying part is a random identifier

Very often the merchant is stable and what changes is an order or reference number - alphanumeric
or purely numeric, usually a suffix.

  AMAZON MKTPL*0B6HF7553      162 distinct descriptions, one payee
  NAME-CHEAP.COM* LFTIOJ      17 distinct descriptions, one payee
  Nintendo CC1568853033       identifier is CC + 10 digits
  Kindle Svcs*BJ5P06V61       identifier is 9 alphanumerics

This is exactly what matching rules are for. Create one (or widen an existing one) so the stable
part matches and the identifier is ignored. Do NOT create a payee per identifier.

### 3. Country codes: where they sit decides what they mean

A country in the TRAILING field is routing information — which entity processed the charge. It is
usually noise. Uber is the clearest case: every one of these is the same payee "Uber".

  UBER *TRIP  NL      (Uber's Netherlands entity)
  UBER*RIDES  GT
  UBER *TRIP  CR
  DL*UBER*RIDES  GUATE

That is why the uber rule is \buber.+(trip|rides)\b and mentions no country at all. When a merchant
behaves this way, ignore the country and match on the service.

A country INSIDE the merchant name field is part of the merchant's identity, and usually means a
separate local business relationship — a different account, a different subscription, a different
bill.

  CLARO MCE MPC CR         SAN J

Here "CR" is inside the merchant name and the city is San Jose. Every mapped Claro transaction is
Guatemalan ("MIPAGO CLARO RECURRENC GT"), so this is Claro COSTA RICA — a separate payee, not the
existing "Claro". Create it.

The test to apply: does this look like the same service billed through a different country, or a
different account in a different country? Uber is the first. Claro CR is the second. If you cannot
tell, prefer a separate payee — merging two payees later is easier than untangling one.

### 4. Unknown merchants: search the web

When nothing in history matches with high confidence, the merchant is genuinely new. Use WebSearch
to find out what it is. Knowing that ANTHROPIC* CLAUDE SUB is a software subscription, that FARMA
SALUD is a pharmacy, or that STRADIVARIUS is a clothing retailer tells you the category directly.

Then create the payee with a clean, human-readable name — "PlayStation", not "PLAYSTATION 650-2".
Match the naming style already in the payee table.

If the merchant is a well-known chain, also consider whether a rule is warranted: a merchant you
will see monthly is worth one.

## Choosing a category

The active categories are listed at the end of this prompt. Rules:

- When you matched a transaction in history, copy its category along with its payee. Do not re-derive
  the category — the pair is the evidence.
- A payee does NOT determine a category. 75 payees legitimately span several: PedidosYa is Groceries
  or Restaurants/Food Delivery depending on the order. Judge from THIS transaction.
- Never choose a category in the "Events" group. Those are manual, date-scoped one-offs
  ("Semana Santa 2023", "Mudanza 2024") that the owner assigns by hand.
- Avoid "Miscellaneous" unless nothing else genuinely fits. It has absorbed 793 transactions since
  2025 and is where categorization goes to die. A specific wrong-ish category is more useful than a
  correct-but-empty one.
- Only create a category when no existing one fits at all. It must attach to an existing group.

## Writing rules

Conventions the existing 21 rules follow. Match them.

- A JS regex SOURCE only: no delimiters, no flags. Matching is case-insensitive already.
- Anchor on the stable merchant text with word boundaries: \bstarbucks\b, \bcemaco\b.
- Ignore the trailing country/city field unless it is genuinely part of the identity.
- priority is a number; existing rules step by 10. Lower runs first.
- Specific before general. The PedidosYa family is the reference:
      160 \bpedidos\s*ya\s+propina
      170 \bpedidos\s*ya\s+(?:super|s[úu]per)
      180 \bpedidos\s*ya\s+plus
      190 \bpedidos\s*ya\b(?!\s+(?:propina|super|s[úu]per|plus))
  The general rule carries a negative lookahead so it cannot swallow its own sub-brands.
- ALWAYS run test_regex before creating or updating a rule. It reports how many mapped transactions
  the pattern hits and whether they agree on one payee. Disagreement means the pattern is too broad
  — narrow it and test again.

A rule decides only WHERE TO LOOK. It never carries a payee. The answer always comes from the most
recent already-mapped transaction the pattern matches.

## When to give up

Returning no match is a correct, useful answer. Say so plainly, with your reasoning, and stop.

Transfers between the owner's own accounts have no payee and must NOT be assigned one. They look
like:

  BI-APP TRANSF A CTA GT 1636438
  TF: ACH INMEDIATO 9004228
  TF:ACH PERSONAS 900417352
  TEF A : 963503024

Bank-generated fees and interest ("COMISION RETIRO CAJAS", "IVA", "INTERESES") also have no payee
unless history already maps that exact fee.

Do not guess to avoid returning nothing. A wrong payee propagates: the next matching transaction
copies it, and so does the one after that. An honest "no match" costs one manual assignment; a
confident wrong answer costs a cleanup.
````

The transaction is supplied in the user prompt: description (verbatim, with padding preserved),
length, date, `amount_cents`, currency, bank key, and account number. The active category list —
name, group, and id — is appended to the system prompt, built from the database at startup rather
than hard-coded.

### Evidence behind the prompt

| Finding | Evidence |
| --- | --- |
| Fixed-width fields: 22+country at len 25, 25+city at len 30 | 1290 rows at len 25 (` GT` ×979, ` US` ×155, ` NL` ×58, ` CR` ×10); 1736 at len 30 (`GUATE` ×579, `SAN J` ×39) |
| Trailing country is noise | Payee "Uber" spans NL, GT, CR, GUATE, US across 18 description variants |
| Embedded country is identity | All 43 mapped Claro rows are GT; `CLARO MCE MPC CR` has CR inside the merchant field, city San José, and no mapped precedent |
| Random identifiers dominate drift | Amazon 162 variants, Spotify 47, Parqueo 40, El Roble 39, Namecheap 17 |
| Rules go stale as counters roll | `\bI\/T-\d+ I000\d+\b` misses `I/T-042926 I001012017` and `I/T-060524 I59665` — 3 unmapped rows |
| Payee does not determine category | 75 multi-category payees over 3,763 txs vs 424 single-category over 2,165 |
| Sub-brand ordering convention | The four PedidosYa rules at priority 160–190 with a negative lookahead on the general one |
| Miscellaneous is over-used | 793 transactions since 2025-01-01, the single largest category |
| Events is manual | 17 date-scoped categories (`Semana Santa 2023`, `Mudanza 2024`); only 41 txs among multi-category payees |

## Structured output

```ts
const Answer = z.object({
  matched: z.boolean(),
  payeeId: z.string().nullable(),
  categoryId: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string(),          // how it reached the answer, for the audit trail
});
```

Kept deliberately shallow — the docs warn that deeply nested schemas with many required fields are
harder to satisfy and drive retry failures. Created/updated ids are *not* in the schema: they are
recorded by the write tools as ground truth.

`matched: true` requires both ids non-null and both to resolve to real rows. The service validates
this. A self-contradictory answer — `matched: true` with a null or unknown id — is treated as a
**failed run**, not as a `none` verdict: it is a model error rather than a genuine finding of "no
match", so it must stay retryable rather than permanently excluding the transaction.

## `matcher_result`

```
id                uuid PK   (uuidv7, app-generated)
bank_tx_id        uuid      NOT NULL → bank_tx.id
type              text      NOT NULL  -- 'exact' | 'rule' | 'ai' | 'none'
payee_id          text      NULL → payee.id
category_id       text      NULL → category.id
source_tx_id      uuid      NULL → bank_tx.id        -- which tx drove an exact/rule match
matching_rule_id  uuid      NULL → matching_rule.id  -- which rule fired
data              jsonb     NULL
created_at        timestamptz NOT NULL default now()
updated_at        timestamptz NOT NULL  -- trg_set_updated_at
```

Index on `bank_tx_id`. No unique constraint — this is an append-only audit log.

`data` for an `ai` or `none` row:

```jsonc
{
  "summary": "…",
  "confidence": "high",
  "created": { "payee_id": "…|null", "category_id": "…|null", "matching_rule_id": "…|null" },
  "updated": { "matching_rule_id": "…|null" }
}
```

Replicated to SQLite (so the backlog skip query stays local), which requires bumping
`EXPECTED_SCHEMA_VERSION` in `replica-db.service.ts`. The replica rebuilds itself once on next boot;
that is the documented, intended recovery path.

### Skip logic

`PayeeResolver.start()` gains:

```sql
AND NOT EXISTS (
  SELECT 1 FROM matcher_result mr
  WHERE mr.bank_tx_id = bank_tx.id AND mr.type = 'none'
)
```

A `none` verdict is terminal. Without it, every restart would re-run the agent on the 17 transfer
rows and every other permanently unresolvable transaction.

**Manual retry** is a one-liner, documented in `projects/tx-payees/CLAUDE.md`:

```sql
DELETE FROM matcher_result WHERE bank_tx_id = '<uuid>' AND type = 'none';
```

`onNewTx` does not need the check — an insert is always a transaction the resolver has not seen.

## Cost and concurrency

The queue is `concurrency: 1` and `match()` blocks on the agent, so a cold backlog runs serially.
All 154 currently-unmapped rows reach tier 3, not just the 133 merchant-shaped ones — transfers and
fees also fall through exact and regex. At ~20–60 s per run, resolving all of them in one pass would
take 50 minutes to 2.5 hours.

`TX_AI_MAX_PER_SWEEP` deliberately prevents that. At the default of 25, the first boot spends ~8–25
minutes and the backlog drains over roughly seven runs rather than one long unattended session. Each
run makes the next cheaper: rules created early convert later rows into free regex hits, and `none`
verdicts permanently remove the unresolvable ones. Raise the cap to drain faster once the tier has
been observed behaving well on a few real transactions.

Controls:

| Env var | Default | Purpose |
| --- | --- | --- |
| `TX_AI_ENABLED` | `true` | kill switch — when false, tier 3 is skipped and `match()` returns `none` with no agent call |
| `TX_AI_MODEL` | `claude-sonnet-5` | model override |
| `TX_AI_EFFORT` | `medium` | effort override |
| `TX_AI_MAX_PER_SWEEP` | `25` | cap on agent calls per backlog sweep; beyond it, remaining rows are left unmapped **without** a `none` verdict so the next boot resumes |
| `TX_AI_TIMEOUT_MS` | `180000` | per-run wall clock; on expiry `query.close()` and treat as failure |
| `TX_AI_SETTLE_TIMEOUT_MS` | `2000` | how long a write waits for `row-persisted` before proceeding with a warning |

`CLAUDE_CODE_OAUTH_TOKEN` is required when `TX_AI_ENABLED` is true; its absence is a startup error,
not a per-transaction failure.

## Error handling

| Failure | Behavior |
| --- | --- |
| Agent throws / times out / no structured output | logged; **no** `matcher_result` row; the tx stays unmapped and is retried next boot |
| Agent returns `matched: false` | `none` row persisted; never retried automatically |
| Agent returns `matched: true` with a null or unknown id | failed run — logged with the offending ids; **no** row, so the tx stays retryable |
| Write tool rejects a pattern | `isError: true` returned to the agent, which may revise; the run continues |
| Postgres write fails | propagates to `PayeeResolver.process`, which already logs and drops so one bad row cannot stall the queue |
| `TX_AI_MAX_PER_SWEEP` reached | remaining rows skipped silently; no rows written |

The existing invariant holds: a single transaction can never stall the backlog.

## Testing

- **`TxMatcher` unit tests stay pure.** All 9 existing tests keep running against in-memory SQLite;
  they become `async` and inject a stub `TxAiMatcher` that returns `none`. This proves tiers 1 and 2
  are unchanged by the refactor.
- **`test_regex` tests** — pure function over a seeded in-memory replica: agreement counts, unmapped
  counts, overlap detection, invalid pattern, catastrophic-backtracking rejection, over-broad
  rejection.
- **Write-tool validation tests** — uuidv7 minting, unknown `groupId` rejected, rule safety checks.
- **Skip-logic test** — a tx with a `none` row is excluded from the backlog query; deleting the row
  re-includes it.
- **Feedback-loop test** — the one that guards the property `concurrency: 1` exists for. Queue two
  transactions with identical descriptions; stub the AI tier so the first call resolves by creating a
  payee and the second call fails the test if invoked. Assert the second transaction is resolved by
  the **exact** tier, and that exactly one payee was created. Without the settle-await this test
  fails, which is the point.
- **`ReplicaSettled` tests** — resolves when the matching `(table, id)` event fires; ignores events
  for other tables/ids; resolves (with a warning) on timeout rather than throwing; and registers its
  listener before the write runs, proven by emitting the event synchronously from inside the write
  callback and asserting it is still observed.
- **Structured-output parsing tests** — success, `error_max_structured_output_retries`,
  success-with-no-output, and self-contradictory `matched: true` with null ids.
- **One live end-to-end run**, manually, against a single real unmapped transaction, with the result
  inspected before the tier is left enabled.

No test calls the real Agent SDK; `TxAiMatcher` is injected and stubbed everywhere.

## Documentation to update

- `projects/tx-payees/CLAUDE.md` — the third tier, the tool surface, the SQLite-read/Postgres-write
  split, `matcher_result`, the manual-retry one-liner, the new env vars. **Also:** replace `new-tx`
  with `row-persisted` in the event-contract table, and correct the "Why `new-tx` is inserts-only"
  section — the feedback loop is prevented by the `payeeId` check, not by the emitter's filter.
- Root `CLAUDE.md` — the `matcher_result` table in the schema section. **Also fix a pre-existing
  error found while writing this spec:** the schema table documents `bank_tx.amount` as `numeric` and
  the unique index as `(bank_account_id, date, doc_no, description, amount)`, but the column has been
  `amount_cents` (bigint) since migration 0004.

## Decisions and rationale

**Why `PayeeResolver` writes `matcher_result`, not `TxMatcher`.** `TxMatcher` returns provenance
(`sourceTxId`, `ruleId`, `data`) and the resolver persists it. This keeps every Postgres write in one
place and keeps `TxMatcher` pure, so its unit tests need no database beyond in-memory SQLite.
Approved as a deviation from the original "matcher stores it" instruction.

**Why narrow write tools instead of a database handle.** Each tool is a single validated operation
with its own schema. Ids are minted by us, invariants are enforced in our code, and the audit trail
records what actually happened rather than what the model says happened.

**Why rules go live without a correctness gate.** Accepted risk, chosen deliberately: gating on
review stalls the compounding benefit that makes the AI tier's cost amortize. `test_regex` gives the
agent the evidence to be right, and `matcher_result` records what it did so a bad rule can be found
and reverted.

**Why `none` is terminal.** 17 of 154 unmapped rows are transfers with no possible payee. Retrying
them every boot spends subscription quota on an unanswerable question. Manual retry is one SQL
statement.
