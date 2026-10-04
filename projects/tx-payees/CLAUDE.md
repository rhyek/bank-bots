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

**NestJS version policy.** Track **v12** — stable 12 has shipped, so a plain `^12` range —
and **never** a 13 (or any other) prerelease. When bumping, keep all three `@nestjs/*` packages
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

`main.ts` listens on `process.env.PORT` and nothing else — no fallback, so a missing value fails
loudly instead of quietly binding some default port. In this monorepo **devtooie
injects `PORT`** for the app's dev process from `devtooie.config.ts`, and loads the `.env` files —
so read config from `process.env`, don't hardcode ports. The `/status/health` endpoint is what
devtooie's `healthcheck` hits.

## Logging (`@rhyek/nestjs-utils`)

Logs are **structured JSON on stdout**, from `@rhyek/nestjs-utils` (its `structured-logger`) —
shared code that `synced-utils` vendors into this repo as TypeScript source, under
`<repo root>/synced-utils/nestjs-utils/`, and this app depends on with `workspace:*`. Its
`src/structured-logger/README.md` is the reference. Level is `LOG_LEVEL` (default `info`); pipe
through `pnpm dlx pino-pretty` to read them.

Wiring is one line in each of two places, and neither can move:

- `main.ts`: `bufferLogs: true` on `NestFactory.create`, then `setupLogging(app)` — installs the
  Nest log adapter, the request-context middleware and the body interceptor.
- `app.module.ts`: `StructuredLoggerModule.forRoot()` — `@Global()`, so `StructuredLoggerService`
  is injectable everywhere. It takes no options today (no inbound auth, no request bodies worth
  stripping); when it needs one, put it in `src/logger/logging.options.ts`.

**Every provider injects `StructuredLoggerService`** — `private readonly logger:
StructuredLoggerService`, as the last constructor parameter — and nothing uses Nest's `Logger` or
`console`. Each injection site gets its own instance already tagged with the injecting class, so
lines carry `"context":"PayeeResolver"` with no `setContext` call. The Nest log adapter that
`setupLogging` installs is only for Nest's own lines.

- **Values go in the object, not the message**: `this.logger.info({ txId, payeeId }, 'matched')`,
  so they are fields you can query on. The message is a short constant.
- **A caught error is passed as `error`**, at any level: `this.logger.warn({ error: err as Error,
  txId }, 'could not locate transaction')`. That is what keeps its stack on the line.
- **`error()` and `fatal()` require `error: Error`**; if there is none to attach, it is a `warn`.
- **Attribute names that recur are declared once**, in `src/logger/log-attributes.ts` (`txId`,
  `payeeId`, `table`, `description`), so they are spelled and typed the same everywhere. Add to it
  when a new name shows up in a second place.
- **A spec builds its service by hand**, so it passes `new StructuredLoggerService()` — the class
  works outside the container. The one script, `seed-matching-rules.ts`, does the same and names
  itself with `setContext`.

`synced-utils/nestjs-utils/` is a **live two-way mirror** of `~/Dev/synced-utils`: an edit there
reaches the shared repo and every other project using it within a second. Fix the logger there when
it needs fixing, but keep it generic (`synced-utils/CLAUDE.md` has the rules). It takes
`@nestjs/common`, `@nestjs/core`, `pino` and `rxjs` as **peers** — which is why `pino` is a direct
dependency here and why the repo keeps one shared pnpm lockfile.

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
  payee-resolver/  gives each bank_tx row a payee + category and a location; orchestrates the rest
    ai/            the AI tier's tools, prompt and output schema
  owner-location/  where the owner was: resolves days (agent), looks transactions up (no agent)
  payee-location/  where a payee is (agent + web search)
  location/        the raw location tracker (Dawarich) + its own per-day SQLite cache
  agent/           runStructuredAgent: the one place an Agent SDK session is configured and run;
                   AgentModels: which model and effort each agent runs on
  testing/         in-memory replica + fixtures for specs
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

**`payee-resolver`.** A `p-queue` with `concurrency: 1`. `start()` runs on `startup-sync-finished`
and sweeps transactions since 2026-01-01, then again every 24 hours; `row-persisted` queues a single
freshly scraped row. Both funnel through `enqueue(txId)`. Per transaction, in this order:

1. make sure the days of its ten-day window are resolved (`owner-location`; may run an agent)
2. match a payee, unless it has one or the AI tier already gave up on it
3. look up where the owner was when it was bought, and record it (no agent)
4. if its payee's own place has never been looked up, look it up (`payee-location`; an agent), and
   once that is known, redo step 3 for that payee's transactions

Steps 1, 3 and 4 are the location steps; see "Location" below. A sweep (`selectBacklog`) picks a
transaction up for any of three reasons: it has no payee and no terminal `none` verdict, it has no
**final** `location` row, or its payee's `location_kind` is NULL.

Payee matching is **three tiers**:

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

**`matcher_result`** records every decision from every tier. A `type = 'none'` row is terminal for
payee matching: the sweep no longer selects the transaction for a payee, and `process()` checks for
it again before matching — it has to, because the same transaction is still selected to be located.
That is what stops the inter-account transfers (which can never have a payee) from costing an agent
call on every sweep. Re-ask one by hand:

```sql
DELETE FROM matcher_result WHERE bank_tx_id = '<uuid>' AND type = 'none';
```

**The AI tier (`TxAiMatcher`).** Built on `@anthropic-ai/claude-agent-sdk`, authenticated with
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` — treat it like a password). It reads the SQLite
replica through four read tools and mutates Postgres through four write tools:

| Read (SQLite, `readOnlyHint`) | Write (Postgres, barriered) |
| --- | --- |
| `find_similar_transactions` | `create_payee` |
| `search_payees` (with per-payee country breakdown and the payee's own place) | `create_category` |
| `list_matching_rules` | `create_matching_rule` |
| `test_regex` | `update_matching_rule` |

Three options are load-bearing and must not be dropped. They are set in `runStructuredAgent`, which
every agent in this app goes through (`builtinTools` is what it passes as `tools`):

- **`tools: ['WebSearch']`** removes every *other* built-in — `Bash`, `Read`, `Write`, `Edit`,
  `Glob`, `Grep` — from the agent's context. Its whole capability surface is those eight tools plus
  web search.
- **`settingSources: []`** stops the SDK loading `~/.claude`, project `.claude/`, or this repo's
  `CLAUDE.md`, so agent behavior can't drift with the owner's dotfiles.
- **`effort`** is set explicitly rather than defaulted; the SDK has silently injected a flag-driven
  effort default before ([#214](https://github.com/anthropics/claude-agent-sdk-typescript/issues/214)).

`z.toJSONSchema(..., { target: 'draft-7' })` is required — the SDK validates draft-07, Zod emits
2020-12 by default, and the mismatch fails the run at startup.

## Location

Two different facts, kept apart (design: `docs/superpowers/specs/2026-10-04-owner-and-payee-location-design.md`):

- **Where a payee is** — `payee.country` / `location` / `location_kind`. Amazon is US wherever it
  was ordered from.
- **Where the owner was when a purchase happened** — `bank_tx.country` / `location`. Often the
  payee's place, often not.

**The AI resolves days, not transactions (`owner-location/`).** "Where was the owner" is a property
of a date. Resolving it per transaction would cost an agent call each and let two charges from one
day disagree; per day it costs one call per run of up to 14 days, and every transaction shares the
answer. `OwnerLocationService.ensureDays(dates)` finds the days that have no answer, or a
provisional one more than 24 hours old, groups them into runs of consecutive days and asks
`DayLocationResolver` once per run. Answers go to `owner_day_location` in **Postgres**, directly —
the table is not replicated, because the replica is dropped on every schema bump and these answers
each cost an agent call.

- **Evidence** (`day-evidence.ts`): the tracker's line for each day of the run and three days either
  side; the debits whose description names a place, posted from the first day of the run to five
  days after its last; and the answers already given for the days either side. That last part
  matters: each run is a separate agent call that sees only its own slice of the charges, and
  without its neighbours a run starting the day after three weeks at home has only the tracker to
  say where the owner was coming from.
- **The agent has no tools.** Everything it may use is in the prompt.
- **A run is all or nothing** (`checkDayAnswers`): an answer that omits a day, repeats one, or names
  something that is not an ISO country code throws, and nothing is written.
- **Finality**: a day resolved at 10 or more days old is final; a younger one is provisional and is
  resolved again after 24 hours. A day resolved while the tracker could not be read is provisional
  whatever its age.
- **Failures are remembered until the queue drains** (`resetFailures`), so one run the resolver
  cannot answer is not re-asked by every transaction whose window touches it.
- **The sweep resolves every day and every city field it will need in its first job**, before any
  transaction. Left to
  the transactions, days would be requested ten at a time in `created_at` order, which is not date
  order, and the resolver would get fragments instead of 14-day runs.

**The tracker has two sources, and one of them invents data (`location/`).** Points since 2026-08
come from the live tracker: real, but sparse, with whole days missing. Earlier points are a Google
Timeline import (`topic` "Google Maps Phone Timeline Export"), which fills a day it has no data for
with 96 copies of its last known coordinate. That filler put the owner in San José for most of
January and early May 2026 while their card was in daily in-person use in Guatemala City.
`summarizeDay` marks such a day `assumed` (every point from the import, one distinct coordinate),
and the day resolver is told an in-person charge outranks it. This is the whole reason a day needs
judgment rather than a lookup. Nothing but `owner-location` should read `LocationService`.

`LocationService.days(dates)` makes **one bounded request per calendar day** (`start_at` + `end_at`,
UTC-6; ~0.3s, where an unbounded "last point before" query takes 6-7s), cached per day in
`storage/location-cache.sqlite` — a file of its own, since this is not replicated data. A day with
points that is more than two days old is settled; a recent or empty day is asked for again after 12
hours, because the phone uploads late. It answers `null` for the whole request when Dawarich cannot
be read, so "nothing recorded that day" and "could not ask" never look alike.

**A transaction's location is a lookup (`tx-location.ts`, no AI).** The bank's date is the POSTING
date; in the 2026 history, Costa Rican shops were dated 2-3 days after the owner had left the
country. So the purchase lies somewhere in the ten days ending on the transaction's date, and
`locateTx` picks the day:

1. **One country in the window** (the usual case): that country, with the place of the day two days
   before posting, or of the nearest day that has one. `rule: single-country`
2. **Several countries, and the payee is `local` or `chain`** (so the owner had to be at the
   branch): the latest day on which the owner was in the branch's country. That country is the one
   the transaction's own description names (`rule: description-country`), and failing that the
   payee's (`rule: payee-country`).
3. **Otherwise**: two days before posting, or the nearest resolved day to that. `rule: posting-lag`
4. **No day places the owner anywhere**: null. `rule: none`

**The description says where the branch is (`place-field.ts`, `place-resolver.ts`).** A trailing
country code is read directly. A city field (`GUATE`, `SAN J`, `ALAJU`) is looked up in
`place_field`, which `OwnerLocationService.ensurePlaces` fills: each distinct field is put to
`PlaceFieldResolver` (an agent, no tools) once, in batches of up to 40 with a few sample
descriptions, and the answer may be "not a place" (`OPENA`, `ANTHR`). The table is loaded into
memory once per process (this service is its only writer), so a row edited by hand takes effect on
the next restart, and only for lookups that are still to be made. The description comes before
the payee's country because it is about this purchase. A global chain's payee has no country at
all, and a payee's country only says where its branches have been so far: Subway was first filed as
a Guatemalan chain because the owner's three charges were. The description is ignored unless the
payee is a physical business — on an online charge the same field holds a billing office or the
merchant's home town.

The result is written to `bank_tx` and appended to `matcher_result` as a `location` row. It is
`final` only when all ten days are resolved for good; a non-final lookup is redone by a later sweep,
and a lookup that says nothing new writes nothing.

**Where a payee is (`payee-location/`).** `PayeeLocationService.resolve` runs for a payee whose
`location_kind` is NULL — whichever tier matched the transaction, and right after the AI tier
creates a payee. The agent gets the payee's name, up to ten statement lines, how its transactions
spread over place fields, and where the owner was for the transaction that triggered it; its only
tool is WebSearch. `checkPayeeLocation` holds the answer to what its kind means. Every answer sets
`location_kind`, `unknown` included, so each payee is asked about once; set it back to NULL by hand
to re-ask.

**Why step 3 runs twice for some transactions.** Rule 2 needs the payee's place, and step 4, which
finds it, comes after step 3 — the matcher wants the transaction's location as evidence. So once
step 4 has an answer, that payee's transactions are looked up again (a lookup that changes nothing
writes nothing). Without this, an airport shop in Costa Rica whose charge posted after the owner
flew home would be recorded in Guatemala, as a final answer. It is also what makes re-asking a
payee safe: if its kind changes, its transactions move with it.

**`chain` means paid in person.** Rule 2 reads `local` and `chain` as "the owner had to be there",
so the payee location prompt files bills and recurring charges — a phone company, an insurer, a gym
membership, a bank — under `remote` with the company's own country, however local the company is.
Filed as `chain`, a phone bill that posts during a trip is moved to the last day the owner was at
home.

**A chain has a country only when all its branches are in one.** La Torre is `chain`, `GT`. A brand
with branches in many countries (Subway, McDonald's, Starbucks, Zara) is `chain` with a NULL
country, judged from what the brand is and not from where the owner's charges happen to be. Its
purchases are still placed correctly, by their own descriptions. `local` is the only kind that must
have a country.

**None of it can fail a payee match.** Each location step is guarded on its own: a failure is
logged, nothing terminal is written, and the next sweep retries. `TX_LOCATION_ENABLED=false`
switches all three off. A payee lookup that fails is not repeated for the same payee until the
queue drains.

**The payee matcher is told where the owner was** (`OwnerLocationService.describe` ->
`buildUserPrompt`): the resolved days of the window, collapsed into runs, plus the lookup's best
estimate for the day of purchase. It is a hint for identifying an unfamiliar merchant and aiming
`WebSearch` at a place, never a reason to split a payee. `search_payees` returns each candidate's
`locationKind`, `country` and `location`.

**Every agent runs through `runStructuredAgent`** (`agent/structured-agent.ts`), which sets the
options listed above as load-bearing in exactly one place. The day resolver passes `builtinTools:
[]` (no tools at all); the payee location matcher and the payee matcher pass `['WebSearch']`.

**Rule patterns are gated on liveness, not correctness.** Rules go live enabled with no review. But
`create_matching_rule` rejects a pattern that doesn't compile, that **nests an unbounded quantifier**
(`(a+)+`), or that matches >30% of mapped history. The nesting check is *static* and deliberately so:
timing a regex means running it first, and `(a+)+$` against a 34-character description is ~2^34 steps
— a timing-only guard hangs instead of reporting. The share check is skipped below 50 mapped rows,
since on a small or freshly-rebuilt replica a good rule can legitimately match most of what's there.

| Env var | Default | Purpose |
| --- | --- | --- |
| `TX_AI_ENABLED` | `true` | kill switch; when false the tier throws (does **not** write a terminal `none`) |
| `TX_AI_MODEL` | *(unset — the latest Sonnet, looked up at boot)* | pins the payee matcher's model; see below |
| `TX_AI_EFFORT` | `high` | the payee matcher's effort |
| `TX_AI_MAX_PER_SWEEP` | *(unset — unlimited)* | opt-in throttle for a large backfill; see below |
| `TX_AI_IDLE_TIMEOUT_MS` | `120000` | **silence**, not duration — rearmed by every message |
| `TX_AI_SETTLE_TIMEOUT_MS` | `15000` | how long a write waits for `row-persisted` |
| `DAWARICH_API_KEY` | *(unset — tracker off)* | key for the owner's Dawarich; treat it like a password. Without it days are resolved from card charges alone, and stay provisional |
| `DAWARICH_URL` | `https://dawarich.homelab.rhyek.com` | Dawarich base URL |
| `TX_LOCATION_ENABLED` | `true` | `false` disables every location step: days, transaction lookups, payee lookups |
| `TX_LOCATION_MODEL` | value of `TX_AI_MODEL` | model for the three location agents: the day resolver, the place field resolver and the payee location matcher |
| `TX_LOCATION_EFFORT` | `medium` | effort for those three agents |
| `LOCATION_CACHE_DB_PATH` | `storage/location-cache.sqlite` | the tracker's per-day cache |

**No Sonnet version is written down in the app (`AgentModels`, `agent/agent-models.service.ts`).**
In `onModuleInit` it asks the Agent SDK what its `sonnet` alias resolves to (`supportedModels()`, the
row whose `value` is `sonnet`, its `resolvedModel`) and every agent uses that id for the life of the
process: the payee matcher at effort `high`, the location agents at `medium`. The lookup starts an
SDK session and closes it without sending a prompt, so it costs no model turn and about a second.

- **"Latest" means the newest Sonnet the installed SDK knows.** The alias table ships inside
  `@anthropic-ai/claude-agent-sdk`: 0.3.214 answered `claude-sonnet-5`, 0.3.288 answers
  `claude-sonnet-5-5`. A newer Sonnet arrives with an SDK upgrade and not before. The boot log's
  `agent model resolved` line says which one is in use.
- **It never fails the boot.** If the lookup throws, times out (30s) or lists no `sonnet` row, it
  warns and hands the agents the alias `sonnet` itself, which the SDK resolves to the same model.
- **Nothing is looked up** when `TX_AI_MODEL` pins the model, or when there is no
  `CLAUDE_CODE_OAUTH_TOKEN` (no agent can run, and a session without a token lists no aliases).
- The process environment is forwarded to the SDK, so `ANTHROPIC_DEFAULT_SONNET_MODEL` there
  changes what the alias resolves to.

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
