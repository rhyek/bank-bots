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
  events/          the typed event bus (@Global) — AppEvents + the event contract
  replica-db/      the SQLite client only — connection, schema, regexp(), version stamp
  replica-sync/    Postgres -> SQLite replication (delta sync + LISTEN/NOTIFY) + /replica/status
  payee-resolver/  matches unmapped bank_tx rows to a payee + category
  status/          /status/health
```

**Modules communicate over events, not references.** `replica-sync` and `payee-resolver` have **no
import relationship in either direction** — one emits, the other listens, and either can be changed
or removed without touching the other. The contract is `AppEventData` in `events/app-events.ts`:

| Event | Payload | Meaning |
| --- | --- | --- |
| `replica-sync.startup-sync-finished` | *(none)* | first full delta sync completed; history is safe to read |
| `replica-sync.new-tx` | `{ id: string }` | a transaction was **inserted** in Postgres (scraped) |

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
2026-01-01 on `startup-sync-finished`; `new-tx` queues a single freshly scraped row. Both funnel
through `enqueue(txId)`. Matching is two tiers — exact description, then `matching_rule` patterns by
priority — and both copy the payee/category from the most recent already-mapped transaction. Hits are
written to **Postgres**, whose trigger notifies the replica.

**Why `new-tx` is inserts-only.** A scraped transaction always arrives unmapped, so an insert always
means real work. It also makes the feedback loop structurally impossible: this module's own payee
writes come back as *updates*, which are never emitted. The trade-off is that a transaction that
fails to match and is later updated (a re-scrape changing `amount_cents`, say) is not re-queued
immediately — it is picked up by the next startup sweep.

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
