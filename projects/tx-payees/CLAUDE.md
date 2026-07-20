# tx-payees — app conventions

A **NestJS** service (scaffolded/updated by the `prepare-nestjs-app` skill). This file holds the
**stack + structure conventions**; the skill's SKILL.md is the setup workflow.

## Stack

**NestJS 12**, native **ESM** (`"type": "module"`), **Express** platform
(`@nestjs/platform-express`). There is **no build step and no `dist`** — the app runs its
TypeScript **directly**:

- `pnpm dev` → `node --import @swc-node/register/esm-register --watch --watch-preserve-output src/main.ts`
- `pnpm start` → the same without `--watch`
- `pnpm typecheck` → `tsc --noEmit` (types only; it never emits)

**Why `@swc-node/register`, not Node's native type stripping.** Node can strip types from `.ts`
directly now, but stripping only *deletes* type syntax — it does **not** emit the
`emitDecoratorMetadata` that Nest's dependency injection reads to know what to inject into a
constructor. `@swc-node/register` transpiles with SWC instead, honoring the two decorator flags in
`tsconfig.json` (`emitDecoratorMetadata` + `experimentalDecorators`), so DI works with no `.swcrc`
and no Nest CLI / `tsc` build. `main.ts` imports `reflect-metadata` once, first, so that metadata
has somewhere to live.

**NestJS version policy.** Track **v12**: the newest 12.x alpha until a stable 12 ships, then stable
12 — and **never** a 13 (or any other) prerelease. When bumping, keep all three `@nestjs/*` packages
on the **same** version. The rationale lives in SKILL.md → Version policy.

## Structure (`src/`)

Standard Nest layering — **modules** compose **controllers** (HTTP) and **providers** (injectable
services) — organized into **feature folders**. `src/main.ts` is the bootstrap
(`NestFactory.create`); `src/app.module.ts` is the root module that imports the feature modules.

- **One folder per feature**, each with its `*.module.ts` and the controllers/providers it owns —
  e.g. the scaffolded `src/status/` (`status.module.ts` + `status.controller.ts`, exposing
  `GET /status/health`). Add a feature by creating its folder + module and importing that module
  into `AppModule` (or a parent feature module).
- Keep `main.ts` thin: create the app, wire global concerns (pipes, filters, CORS), `listen`.
- Providers are classes with `@Injectable()`, injected by **constructor** — the metadata that makes
  this work is exactly what `@swc-node/register` emits (see above).

## Imports — the `~/` alias

`~/*` → `src/*` (tsconfig `paths`; swc-node honors it at runtime and `tsc` for the typecheck). Use
`~/` for anything **cross-tree**; relative `./` only for **siblings**. No `@/`, no `#/`.

## Port & config

`main.ts` listens on `process.env.PORT` (falling back to a default). In this monorepo **devtooie
injects `PORT`** for the app's dev process from `devtooie.config.ts`, and loads the `.env` files —
so read config from `process.env`, don't hardcode ports. The `/status/health` endpoint is what
devtooie's `healthcheck` hits.

## Consuming workspace libraries (source-only)

Shared libraries in this monorepo are **source-only**: their `package.json` `exports` point straight
at `src` (no build, no `dist`, no TypeScript project references). Depend on one with a plain
`workspace:*` entry — pnpm links it, `tsc --noEmit` type-checks against its source through its
`exports`/`types`, and `@swc-node/register` transpiles that source on the fly when the app runs.
That's why this app's `tsconfig.json` has **no `references`** array. See the `prepare-monorepo`
skill for how those libraries are shaped.

## Feature modules

```
src/
  events/          the typed event bus (@Global) — AppEvents, the event contract, ReplicaSettled
  replica-db/      the SQLite client only — connection, schema, regexp(), version stamp
  replica-sync/    Postgres -> SQLite replication (delta sync + LISTEN/NOTIFY) + /replica/status
  payee-resolver/  matches unmapped bank_tx rows to a payee + category
    ai/            the AI tier's tools, prompt and output schema
  status/          /status/health
```

**Modules communicate over events, not references.** `replica-sync` and `payee-resolver` have **no
import relationship in either direction** — one emits, the other listens, and either can be changed
or removed without touching the other. The contract is `AppEventData` in `events/app-events.ts`:

| Event | Payload | Meaning |
| --- | --- | --- |
| `replica-sync.startup-sync-finished` | *(none)* | first full delta sync completed; history is safe to read |
| `replica-sync.row-persisted` | `{ table, op, id }` | a row was applied **to SQLite**; emitted after the write |

`AppEvents` extends **emittery** (`Emittery<AppEventData>`), so `emit` and `on` are both checked
against that map — an unknown event name, a missing payload, or a wrong payload shape is a compile
error. Dataless events are emitted as `emit('name')` with no second argument, and their listener's
`data` is typed `undefined`.

> **Why emittery and not `@nestjs/event-emitter`.** The Nest-native package peer-depends on
> `@nestjs/common@^10 || ^11`, and this app pins **v12**. Revisit if it gains v12 support.

**`replica-db` vs `replica-sync`.** `payee-resolver` needs the replica *client* to read from, but has
no interest in replication. Keeping the client in its own module lets consumers depend on exactly
that, and keeps `replica-db` feature-agnostic. (This split originally existed to break a dependency
cycle; the event bus removed the cycle, but the separation is still the right boundary.)

**Startup ordering.** `ReplicaSync.onApplicationBootstrap` connects the listener and runs the delta
sync, then emits `startup-sync-finished` — guarded by a flag so reconnect-triggered syncs don't
re-announce. `PayeeResolver` subscribes in **`onModuleInit`**, deliberately: Nest runs every
`onModuleInit` before any `onApplicationBootstrap`, so the listener is guaranteed to exist before the
event can fire, rather than depending on `ReplicaSync`'s first `await` happening to yield. If the
initial sync fails nothing is emitted; the existing backoff retries and the sweep runs on the first
sync that succeeds.

**`payee-resolver`.** A `p-queue` with `concurrency: 1`. `start()` sweeps unmapped transactions since
2026-01-01 on `startup-sync-finished`; `row-persisted` queues a single freshly scraped row. Both
funnel through `enqueue(txId)`. Matching is **three tiers**:

1. **exact** — same description in already-mapped history
2. **rule** — `matching_rule` patterns by priority
3. **ai** — `TxAiMatcher`, only when 1 and 2 both miss

Tiers 1 and 2 copy the payee/category from the most recent already-mapped transaction; a rule only
decides *where to look* and never carries an answer. Hits are written to **Postgres**, whose trigger
notifies the replica.

**Why `concurrency: 1` is a feedback loop, not just serialization.** Each resolved transaction
becomes history the next one can copy from — resolving `PLAYSTATION 650-2` once should make the other
six occurrences free. That only holds if the write is visible locally before the next job's
exact-tier `SELECT`, which runs microseconds later. See `ReplicaSettled`.

**Why the insert-only filter lives in the consumer.** `row-persisted` is a bare replication fact, so
payee-resolver filters for `table === 'bank_tx' && op === 'insert'` itself. That filter is *not* what
prevents a feedback loop from our own payee writes — the `payeeId != null` check in `onNewTx` does
that, and would hold without it. What inserts-only actually prevents is narrower: re-queueing a
still-unmatched row when an unrelated field changes (a re-scrape touching `amount_cents`). Those wait
for the next startup sweep.

**`ReplicaSettled` — the write barrier.** `settle.around(table, id, write)` registers a one-off
`row-persisted` listener, *then* runs the write, then waits for confirmation. Registering after the
write would let a fast notification land in the gap and cost the full timeout every time; taking the
write as a callback makes that ordering impossible to invert. On timeout it warns and continues —
Postgres already has the truth, so a lost notification must never fail the work it guards.

Waiting, rather than writing through to SQLite ourselves, keeps `replica-sync` the single writer to
the replica and avoids duplicating its `Descriptor`/`excludedSet()` row mapping in a second module.

**`matcher_result`** records every decision from every tier. A `type = 'none'` row is terminal: the
backlog sweep excludes it, which is what stops the ~17 inter-account transfers (which can never have
a payee) from costing an agent call on every boot. Re-ask one by hand:

```sql
DELETE FROM matcher_result WHERE bank_tx_id = '<uuid>' AND type = 'none';
```

**The AI tier (`TxAiMatcher`).** Built on `@anthropic-ai/claude-agent-sdk`, authenticated with
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` — treat it like a password). It reads the SQLite
replica through four read tools and mutates Postgres through four write tools:

| Read (SQLite, `readOnlyHint`) | Write (Postgres, barriered) |
| --- | --- |
| `find_similar_transactions` | `create_payee` |
| `search_payees` (with per-payee country breakdown) | `create_category` |
| `list_matching_rules` | `create_matching_rule` |
| `test_regex` | `update_matching_rule` |

Three options are load-bearing and must not be dropped:

- **`tools: ['WebSearch']`** removes every *other* built-in — `Bash`, `Read`, `Write`, `Edit`,
  `Glob`, `Grep` — from the agent's context. Its whole capability surface is those eight tools plus
  web search.
- **`settingSources: []`** stops the SDK loading `~/.claude`, project `.claude/`, or this repo's
  `CLAUDE.md`, so agent behavior can't drift with the owner's dotfiles.
- **`effort`** is set explicitly rather than defaulted; the SDK has silently injected a flag-driven
  effort default before ([#214](https://github.com/anthropics/claude-agent-sdk-typescript/issues/214)).

`z.toJSONSchema(..., { target: 'draft-7' })` is required — the SDK validates draft-07, Zod emits
2020-12 by default, and the mismatch fails the run at startup.

**Rule patterns are gated on liveness, not correctness.** Rules go live enabled with no review. But
`create_matching_rule` rejects a pattern that doesn't compile, that **nests an unbounded quantifier**
(`(a+)+`), or that matches >30% of mapped history. The nesting check is *static* and deliberately so:
timing a regex means running it first, and `(a+)+$` against a 34-character description is ~2^34 steps
— a timing-only guard hangs instead of reporting. The share check is skipped below 50 mapped rows,
since on a small or freshly-rebuilt replica a good rule can legitimately match most of what's there.

| Env var | Default | Purpose |
| --- | --- | --- |
| `TX_AI_ENABLED` | `true` | kill switch; when false the tier throws (does **not** write a terminal `none`) |
| `TX_AI_MODEL` | `claude-sonnet-5` | model |
| `TX_AI_EFFORT` | `medium` | effort |
| `TX_AI_MAX_PER_SWEEP` | *(unset — unlimited)* | opt-in throttle for a large backfill; see below |
| `TX_AI_IDLE_TIMEOUT_MS` | `120000` | **silence**, not duration — rearmed by every message |
| `TX_AI_SETTLE_TIMEOUT_MS` | `15000` | how long a write waits for `row-persisted` |

**Why there is no default call budget.** A per-sweep cap guards against runaway spend under metered
API billing. This runs on a Claude subscription: there is no per-call charge, and the only ceiling is
rate limits — which are self-correcting, since a limited call errors, the transaction stays unmapped,
and the next sweep retries it. A default cap bought nothing and cost availability: once spent, the
service kept running while silently skipping every transaction, including newly scraped ones, until
someone restarted it. The work is bounded anyway (finite backlog, terminal `none` verdicts,
`maxTurns`). When the budget *is* set, it now resets whenever the queue drains, so it throttles a
batch rather than the process.

**Why the agent timeout measures silence.** A wall-clock cap kills the wrong runs: an agent working
through several web searches on an unfamiliar merchant is making progress, and cutting it off throws
all of that away. The clock is rearmed by every message the session emits, so it only fires when the
agent has genuinely stopped producing output. Total runtime stays bounded by `maxTurns`.

**Why the settle timeout is 15s and not 2s.** A NOTIFY round trip measures ~70ms on an idle process,
which made 2s look like enormous headroom. It isn't: under real queue load the same round trip takes
~1s, and during an agent run it routinely exceeds 2s — so a 2s budget timed out on essentially every
write and silently dropped the feedback loop it exists to protect. Waiting longer is nearly free (it
only delays the next transaction, and the agent run ahead of it takes 20–60s); timing out early costs
a duplicate payee per repeated description. `TX_DEBUG_BARRIER=1` traces registrations, notifications
and matches if this ever needs re-diagnosing.

**`regexp()` is registered by `ReplicaDb`.** SQLite defines no `REGEXP` function — the grammar
accepts `X REGEXP Y` (which compiles to `regexp(Y, X)`, **pattern first**) but the statement fails at
`prepare()` with "no such function". Registering it gives real JS regex semantics, which the rule
patterns need for `\b` and negative lookahead.

**Replica schema changes require bumping `EXPECTED_SCHEMA_VERSION`** in `replica-db.service.ts`.
`CREATE TABLE IF NOT EXISTS` cannot evolve an existing file, so a mismatch drops and rebuilds the
replica; the empty watermark then makes the next delta sync a full re-pull. That is the intended
recovery — the replica is a disposable cache.

## Build / deploy

Dev is `pnpm dev`. There's no compile artifact — production runs the same way the app runs locally
(`node --import @swc-node/register/esm-register src/main.ts`) with real `node_modules`, so a
container just needs Node, the installed deps, and the source. (No Dockerfile is scaffolded by
default; add one if the service is deployed standalone.)
