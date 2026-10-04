# scrape-txs — app conventions

A **NestJS** service (shaped by the `prepare-nestjs-app` skill, like `tx-payees`). It scrapes the
owner's bank transactions into Postgres: once a day from one cron schedule, and on demand over a
REST endpoint. The first half of this file is the stack + structure conventions shared with
`tx-payees`; "This service" below is what is specific to the scraper. Design:
`docs/superpowers/specs/2026-10-04-scrape-txs-nestjs-service-design.md`.

## Stack

**NestJS 12**, native **ESM** (`"type": "module"`), **Express** platform
(`@nestjs/platform-express`). There is **no build step and no `dist`** — the app runs its
TypeScript **directly**:

- `pnpm start` → `node --import @swc-node/register/esm-register src/main.ts`
- `pnpm typecheck` → `tsc --noEmit` (types only; it never emits)
- `pnpm test` → `node --test` over `src/**/*.spec.ts`

There is **no `dev` (watch) script, on purpose**: a reload in the middle of a scrape kills it. After
a code change, restart the service.

**Why `@swc-node/register`, not Node's native type stripping.** Node can strip types from `.ts`
directly now, but stripping only *deletes* type syntax — it does **not** emit the
`emitDecoratorMetadata` that Nest's dependency injection reads to know what to inject into a
constructor. `@swc-node/register` transpiles with SWC instead, honoring the two decorator flags in
`tsconfig.json` (`emitDecoratorMetadata` + `experimentalDecorators`), so DI works with no `.swcrc`
and no Nest CLI / `tsc` build. `main.ts` imports `reflect-metadata` once, first, so that metadata
has somewhere to live.

**NestJS version policy.** Track **v12**, stable — a plain `^12` range — and **never** a
prerelease, of 12 or of 13. (A prerelease also breaks logging: it doesn't satisfy the peer range of
`@rhyek/nestjs-utils`, which then loads its own copy of Nest.) When bumping, keep all three `@nestjs/*` packages
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
`~/` for anything **cross-tree**; relative `./` only for **siblings**. No `@/`, no `#/`. Imports are
**extensionless** — never `.ts`/`.js` — which is what `moduleResolution: "bundler"` buys.

**`~/` is app-only.** swc-node resolves `paths` from the *running process's* tsconfig, so a `~/foo`
written inside a source-only workspace library would resolve against THIS app's `src`, not the
library's. Inside a library use relative imports or its own package name.

## Port & config

`main.ts` listens on `process.env.PORT` with **no literal fallback** — a hardcoded default lets the
app quietly bind an unallocated port when the env fails to load, which is the exact collision the
port registry prevents. Fail loudly instead. In this monorepo **devtooie injects `PORT`** for the
app's process from `devtooie.config.ts`: **22250**, the first port of bank-bots' block
(22250–22299) in `~/Dev/reserved_port_ranges.txt`. Running the app outside a devtooie session means
`pnpm devtooie cmd -p scrape-txs -c start`, which injects the same `PORT` and `.env` files. The
`/status/health` endpoint is what devtooie's `healthcheck` hits.

## Logging (`@rhyek/nestjs-utils`)

Logging comes from **`@rhyek/nestjs-utils`** (its `structured-logger`) — shared code that
`synced-utils` vendors into this repo as TypeScript source, under `<repo root>/synced-utils/nestjs-utils/`,
and this app depends on with `workspace:*`. Its `src/structured-logger/README.md` is the reference
for the logger API.

That directory is a **live two-way mirror** of `~/Dev/synced-utils`: an edit there reaches the
shared repo and every other project using it within a second. Fix the logger there when it needs
fixing, but keep it generic — nothing specific to this app (`synced-utils/CLAUDE.md` has the rules).

The package takes `@nestjs/common`, `@nestjs/core`, `pino` and `rxjs` as **peers** — which is why
`pino` is a direct dependency here, why the repo keeps **one shared pnpm lockfile**, and why every
Nest app in the repo stays on the same `@nestjs/*` version: that is what makes the package load
this app's own copy of Nest.

**This app owns exactly one logging file: `src/logger/logging.options.ts`.** All configuration goes
there — never inline in `app.module.ts`, where it buries the feature modules. If the app needs no
config, call `forRoot()` bare and delete the file.

Wiring is one line in each of two places, and neither can move:

- `main.ts`: `bufferLogs: true` on `NestFactory.create`, then `setupLogging(app)` — installs the
  Nest log adapter, the request-context middleware and the body interceptor. `bufferLogs` must be a
  create-time option.
- `app.module.ts`: `StructuredLoggerModule.forRoot(loggingOptions)` — `@Global()`, so one import
  makes the logger injectable everywhere. It must run before Nest instantiates the providers that
  inject a child logger.

**Inject `StructuredLoggerService`; never construct a logger.**

```ts
constructor(private readonly logger: StructuredLoggerService) {}

this.logger.info({ orderId }, 'order placed');
this.logger.error({ error, orderId }, 'charge failed');
```

Each injection site gets a child logger already tagged with the injecting class, so every line
carries `"context":"CheckoutService"` with no `setContext` call. Two shapes only — `(message)` or
`(attributes, message)`; there is no printf interpolation, because an interpolated message is a
string you can't query on. `error()` and `fatal()` require `error: Error`; if there's none to
attach, it's a `warn`. `createError` logs and returns a throwable in one step.

**Never thread a logger or a context value through function arguments.** Request data (`req.method`,
`req.url`, headers, body) rides on every line via AsyncLocalStorage. Enrich it mid-request with
`setRequestContext({ ... })` — e.g. the caller id once auth resolves. For ambient state outside a
request (a queue consumer, a job runner), add a **mixin** in `logging.options.ts`.

Widen the autocompleted attribute set by declaration merging, next to whatever owns the concept:

```ts
declare module '@rhyek/nestjs-utils' {
  interface LogAttributes { orderId?: string }
  interface RequestContextExtras { clientId?: string }
}
```

**Keeping values out of the logs is the `strip` option in `logging.options.ts`** — one rule per
place a credential arrives: `headers` and `url` are name-pattern rules (on by default; an array
replaces the default, so include `DEFAULT_SENSITIVE_HEADERS` / `DEFAULT_SENSITIVE_URL_PARAMS` to
extend), and `json` is a path rule over the request body, written as the path appears in the payload.

**When this app gains a new way to authenticate, update `strip` in the same change.** A new guard,
passport strategy, webhook verifier or service-to-service key means a new credential in a header or
body field, and the defaults only catch generic spellings — they know nothing about a house-specific
name like `x-house-key`. Two things `strip` can't reach, worth avoiding by design: a credential in a
**non-JSON body**, and one in the **query string** (`strip.url` cleans these logs, but the same URL
is already in the proxy access log, browser history and `Referer` — prefer a header).

**Request bodies are logged** by the package's body interceptor, which `setupLogging` installs.
To keep a field out, add its path to `strip.json`.

## Consuming workspace libraries (source-only)

Shared libraries in this monorepo are **source-only**: their `package.json` `exports` point straight
at `src` (no build, no `dist`, no TypeScript project references). Depend on one with a plain
`workspace:*` entry — pnpm links it, `tsc --noEmit` type-checks against its source through its
`exports`/`types`, and `@swc-node/register` transpiles that source on the fly when the app runs.
That's why this app's `tsconfig.json` has **no `references`** array. Its compiler options match
`tsconfig.json` in `tx-payees` (this repo has no shared base config), plus the `DOM` lib: the bank
flows pass functions to Playwright that run inside the page.

**A library that imports `@nestjs/*` declares it as a `peerDependency` only** — never also a
devDependency. With the workspace's single shared lockfile, that links the library to this app's
own copy of Nest. Two copies still boot and DI still works, but `instanceof HttpException` is false
across them, so an exception thrown by the library reaches the client as a 500.

See the `prepare-monorepo` skill for
how those libraries are shaped, and for the linter hazard that matters most here:
`consistent-type-imports` rewrites injected constructor types to `import type`, which erases the DI
metadata and breaks this app at runtime while every check stays green. The repo's `eslint.config.ts`
turns that rule off for `projects/scrape-txs/**` and `projects/tx-payees/**`. Never write
`import type` for a class a constructor injects.

## Build / deploy

There's no compile artifact and nothing is deployed: the service runs on the owner's machine under
devtooie (`node --import @swc-node/register/esm-register src/main.ts`).

## This service

```
src/
  main.ts, app.module.ts   bootstrap; the global nestjs-zod pipe + serializer
  logger/                  logging.options.ts — the run mixin
  status/                  GET /status/health
  bank-config/             the bank keys (one z.enum) and the `config` row loader
  credentials/             BankCredentialsService + the `bw` CLI seam
  scrape/
    scrape.controller.ts   the REST routes
    scrape.dto.ts          every Zod schema and DTO of the service
    scrape-schedule.service.ts   the one cron
    scrape-runs.service.ts batches, the per-bank lock, alerts on failure
    scrape-run.store.ts    the `scrape_run` table
    scrape-job.service.ts  one bank: browser, attempts, trace, persistence
    scrape-alert.service.ts, mail.ts   failure emails
    months.ts              which months a run covers
    banks/                 the Playwright flows (bac/, banco-industrial/) and their helpers
```

### Batches: how a scrape starts

Every scrape is a **run**, and runs start in **batches** (`ScrapeRunsService.startBatch`). The
scheduled tick is a batch of the three bank keys; a `POST` is a batch of one. There is no second
code path.

1. Banks that already have a run in progress are left out (the **per-bank lock**, in memory, taken
   before the first `await`). The endpoint answers `409` for them; the schedule logs and skips.
2. Each started run gets its months (below) and is stored in `scrape_run` as `running`. The caller
   gets the runs back at once; everything after this happens in the background.
3. The `config` row is read and **credentials are fetched once, for all the batch's banks**
   (`BankCredentialsService.fetch(bankKeys, config)`: one Bitwarden session).
4. The batch **forks**: one `ScrapeJobService.run` per bank, concurrently, each handed its
   credentials. The job never talks to Bitwarden.
5. Each run ends on its own — `succeeded` or `failed` — and its row is updated.

### Isolation: one bank failing must not affect another

| | Shared between banks? |
| --- | --- |
| Chromium process | No. One per run, headless. |
| Browser context | No. One per attempt (2 attempts), so a retry inherits no cookies. |
| Bitwarden session | Yes, per batch, and only before any browser opens. A broken item fails its own bank only (`scope: 'item'`); a session that cannot open fails the whole batch (`scope: 'session'`) with ONE alert. |
| Database pool | Yes; each run persists in its own transaction. Nothing ever calls `pool.end()`. |
| Errors | Caught inside the run. The fork waits with `Promise.allSettled`, and the un-awaited batch promise has a terminal `.catch` — an unhandled rejection would kill the process and every run in it. |

`BankCredentialsService` **queues its calls**: `bw` keeps one state directory, and a second session
locking it while the first still reads breaks the first. A manual run requested during the
scheduled fetch simply waits. The state directory is `<repo root>/storage/bitwarden-cli`; a spec
pins that path, because resolving a fresh one would make `bw` log in again as a new device.

A restart in the middle of a scrape aborts it. Nothing is half-written (a run persists in a single
transaction at its end), and the row it left `running` is failed on the next boot.

### Which months a run covers (`months.ts`)

Months asked for in the request are used as given. Otherwise a run covers **every month from 10 days
before its bank's last successful full scrape through the current month**, and never fewer than the
old rule (the current month, plus the previous one through the 10th).

- "Last successful full scrape" is read from `scrape_run`: `succeeded`, not a dry run, no `account`
  filter, and a run that **covered the month it ran in** — a backfill of March run in October says
  nothing about October.
- The 10 days are for transactions that post late; they are also what the "through the 10th" rule
  was for.
- So a scrape every day behaves like the old rule, and after a gap (the Mac was asleep at 07:00 for
  a week across a month end) the next run reaches back to where the gap began. There is **no
  catch-up of a missed tick**; the next run that does happen covers it.
- **The reach is capped at 4 months** (the current one and the three before it,
  `MAX_AUTOMATIC_MONTHS`). BAC's statement picker only offers recent months, and a run that asks for
  one it no longer offers fails — which would leave the last success where it was and make every
  later run fail the same way. Months beyond the cap are not scraped; the run logs a warning and
  emails the owner the list, with the `POST` that backfills them. Months asked for explicitly are
  never capped.
- Banco Industrial savings still cannot reach further back than the previous month. An older month
  is logged and skipped for that account (see the root `CLAUDE.md`).

### The headless browser

`chromium.launch({ headless: true, channel: 'chromium' })`. `channel: 'chromium'` is Chromium's
**new headless** mode — the full browser without a window — instead of Playwright's default cut-down
*headless shell*. Both announce themselves as `HeadlessChrome/<version>` in the user agent, so each
context overrides it with `chromeUserAgent(browser.version())`: the launched browser's own major,
never a constant that drifts from the engine. After upgrading `playwright`, install its browser with
`pnpm -C projects/scrape-txs exec playwright install chromium`.

### REST

No authentication: a local service. Bodies and params are validated by **`nestjs-zod`** (DTOs from
`createZodDto`, `ZodValidationPipe` as the global pipe), and what a route returns is checked against
the DTO it declares with `@ZodSerializerDto` (`ZodSerializerInterceptor`, global).

| Route | |
| --- | --- |
| `POST /scrape/:bankKey` | Body, all optional: `months` (`["2026-09"]`), `account`, `dryRun`. `202` with the run. `400` for an unknown bank key, a month that is not `YYYY-MM`, or an unknown field. `409` (with the `runId` in progress) when that bank is already running. |
| `GET /scrape/runs/:runId` | The run: `status` (`running`/`succeeded`/`failed`), times, `params`, and `result` (`upserted`, `deleted`, `balancesUpdated`, `dryRunPath`) or `error` (`message`, `stage`, `tracePath`). |
| `GET /scrape/runs` | The 50 most recent runs, newest first. |

- `error.stage` says where a run stopped: `config` (the `config` row, or an `account` that is not
  the bank's), `credentials` (Bitwarden), `scrape` (the bank's site), `persist` (the database).
- A **dry run** writes `storage/runs/<runId>/scraped.json` and nothing to `bank_tx`; its counts are
  what a real run would have upserted and deleted. It does not count as a successful scrape for the
  months rule.
- A failed run's trace is `storage/runs/<runId>/trace.zip`. The directory is created only when
  something is written to it.

**A `nestjs-zod` detail that matters.** It validates a parameter only when its *type* is a ZodDto,
so route params are taken whole — `@Param() { bankKey }: BankKeyParamsDto` — never
`@Param('bankKey') bankKey: string`, which would let any string through. And the body schema maps
`undefined` to `{}`, because Express 5 leaves `req.body` undefined for a POST with no body.

**`nestjs-zod` and NestJS 12.** `nestjs-zod` 5.5.0 declares `@nestjs/common ^10 || ^11` as its peer.
It works on 12 (proven on a real boot: a bad body is a `400` in its format, a wrong response shape
is a `500`), and the mismatch is allowed for that one package in `pnpm-workspace.yaml`
(`peerDependencyRules`). Drop that rule once a release widens the range.

### Alerts

One email per failed run, subject `Scrape bank txs failed for <bankKey>`, to `MAILER_ME`. A batch
that fails as a whole (the `config` row cannot be read, Bitwarden cannot be opened) sends one email
naming all its banks. A scheduled tick that could not even store its runs sends one too, and so does
a run whose gap is longer than the automatic reach (see the months rule). A failure to send is
logged and changes nothing about the run.

### Logging in a run

`runContext` (an `AsyncLocalStorage`) is set around each bank's job, and the `runMixin` in
`logger/logging.options.ts` puts `run: { runId, bankKey }` on every line logged inside it. The bank
flows are plain functions, so they are handed the job's logger (`log`) — the one place a logger is
passed as an argument. A manual run's lines also carry the request that started it (`req`), because
the request context is ambient too. Credentials are passed as arguments and never put in log
attributes.

### Testing

Specs are `*.spec.ts` with `test(...)`, hand-built instances, and fakes through constructors. The
two seams to the outside are abstract classes used as injection tokens: `BwCli` (the `bw` binary)
and `ScrapeRunStore` (the `scrape_run` table). The bank flows have no specs: they are proven by a
real dry run against the bank.
