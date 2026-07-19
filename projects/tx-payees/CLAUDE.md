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
  replica-db/     the SQLite client only — connection, schema, regexp(), version stamp
  replica-sync/   Postgres -> SQLite replication (delta sync + LISTEN/NOTIFY) + /replica/status
  tx-payees/      matches unmapped bank_tx rows to a payee + category
  status/         /status/health
```

**Why `replica-db` and `replica-sync` are separate modules.** `tx-payees` needs the replica *client*
to read from, and `replica-sync` needs `tx-payees` to hand work to. If one module owned both the
client and the sync, that would be a dependency cycle needing `forwardRef`. Splitting them makes the
graph `ReplicaDb ← TxPayees ← ReplicaSync` — acyclic, and `replica-db` stays feature-agnostic so the
next consumer just imports it too.

**Startup ordering.** `ReplicaSync.onApplicationBootstrap` connects the listener, runs the delta
sync, and only then calls `txPayees.start()` — guarded by a flag so reconnect-triggered syncs don't
re-trigger it. Matching against a half-populated replica would copy from incomplete history. If the
first sync fails, `start()` simply isn't called; the existing backoff retries and the backlog sweep
runs on the first sync that succeeds.

**`tx-payees`.** A `p-queue` with `concurrency: 1`. `start()` sweeps unmapped transactions since
2026-01-01; `enqueue(txId)` is the single entry point, also used by `ReplicaSync`'s notify handler
when a new or changed `bank_tx` arrives with a null payee. Matching is two tiers — exact description,
then `matching_rule` patterns by priority — and both copy the payee/category from the most recent
already-mapped transaction. Hits are written to **Postgres**, whose trigger notifies the replica; the
row comes back with `payee_id` set, so it isn't re-enqueued and the loop terminates.

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
