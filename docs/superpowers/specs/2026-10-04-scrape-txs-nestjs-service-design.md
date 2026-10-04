# scrape-txs as a NestJS service

**Date:** 2026-10-04
**Component:** `projects/scrape-txs`, `projects/db`, `devtooie.config.ts`, `~/Dev/reserved_port_ranges.txt`
**Status:** approved and implemented on 2026-10-04. Where the build departs from this document,
"Implementation notes" at the end says how and why.

## Goal

Turn `scrape-txs` from a one-shot CLI into a long-running NestJS 12 service shaped like `tx-payees`,
which:

- scrapes all three bank logins once a day from a single cron schedule, concurrently;
- lets each bank be scraped on demand through a REST endpoint, with parameters;
- keeps the banks independent: one failing never affects another.

The Playwright flows for each bank (`bac/scrape.ts`, `banco-industrial/scrape.ts`) are not
redesigned. They move, and they log through the service's logger; nothing else about them changes.

## Decisions taken with the owner

| Question | Decision |
| --- | --- |
| How many concurrent scrapes per tick? | Three: one per bank key (`bancoIndustrialGt`, `bacGt`, `bacCr`), each its own Bitwarden login. |
| Browser isolation | One Chromium **per scrape**, and a fresh context per attempt, as today. A crashed browser can only take down its own bank. |
| Does the endpoint wait for the scrape? | No. `POST` answers 202 with a run id; a `GET` reports the run. |
| How are credentials fetched? | One service call takes an **array of bank keys** and returns the credentials for all of them. The scrapes are forked from there, each handed its credentials. |
| Request validation | `nestjs-zod`, not NestJS 12's built-in Zod support. |
| Headed or headless? | **Headless.** No Chromium window opens. |
| Playwright version | Upgraded to the latest stable (1.63.0 today, from 1.61.1), with the Chromium it ships. |
| Where is run history kept? | In a `scrape_run` table (decided during the build; see "Implementation notes"). |
| How far back does a run with no months reach? | To the bank's last successful scrape, read from `scrape_run` (same). |

## What replaces what

| Today | After |
| --- | --- |
| `src/console.ts` + `commander` (`--bank-key`, `--month`, `--account`, `--json`, `--trace-dir`) | `POST /scrape/:bankKey` with a JSON body. The CLI is deleted. |
| `run()` in `src/lib/run.ts` does everything for one bank and ends the DB pool | Split into the credentials service, the batch/registry service and the one-bank job. The pool stays open for the life of the process. |
| Run on demand through `devtooie cmd scrape-txs -c start -- …` | An always-on devtooie package with a port and a healthcheck. |
| `console.log` | The structured logger from `@rhyek/nestjs-utils`, as in `tx-payees`. |
| Traces in `storage/playwright-traces/`, or `--trace-dir` | One directory per run: `storage/runs/<runId>/`. |

## Structure (`projects/scrape-txs/src`)

```
main.ts                    bootstrap: NestFactory, setupLogging, listen on PORT (no fallback)
app.module.ts              StructuredLoggerModule, ScheduleModule, StatusModule, ScrapeModule
status/                    GET /status/health
bank-config/               the bank-key enum and the `config` row loader (Zod)
credentials/               BankCredentialsService + the `bw` CLI wrapper
scrape/
  scrape.controller.ts     the three routes
  scrape.dto.ts            nestjs-zod DTOs
  scrape-schedule.service.ts   the one cron
  scrape-runs.service.ts   batches, the per-bank lock, the in-memory run registry
  scrape-job.service.ts    one bank: browser, attempts, trace, persistence
  scrape-alert.service.ts  failure emails
  months.ts                the default-months rule
  banks/                   bac/, banco-industrial/, occurrences.ts, bank-accounts.ts, utils.ts
```

Each unit has one job:

- **`bank-config`** owns the list of bank keys (a single `z.enum`, used by the config schema, the
  DTOs and the schedule) and reads the `config` row. It is read once per batch, so an edit to the
  row takes effect on the next run with no restart.
- **`credentials`** turns bank keys into credentials. It knows Bitwarden; nothing else does.
- **`scrape-runs`** decides what runs, records it, and forks. It knows nothing about Playwright.
- **`scrape-job`** runs one bank with credentials it was given. It knows nothing about Bitwarden,
  schedules or HTTP.

## Credentials

```ts
type CredentialsResult =
  | { ok: true; credentials: BankCredentials }
  | { ok: false; error: Error };

class BankCredentialsService {
  fetch(bankKeys: BankKey[], config: Config): Promise<Map<BankKey, CredentialsResult>>;
}
```

One call is one Bitwarden session: `status` (and `login --apikey` if unauthenticated) → `unlock` →
`sync` → `get item` once per requested key → `lock`. For `bancoIndustrialGt` the item's
`campoInstalacion` field is read as the login code, as today.

Two kinds of failure, kept apart:

- **The session fails** (missing `BW_*` variable, login, unlock or sync): every requested key gets
  that error.
- **One item fails** (not found, no password, no code field): only that key gets an error. The other
  keys still get their credentials.

Calls never overlap. The `bw` CLI keeps one state directory, and a second session locking it while
the first is still reading breaks the first. So the service queues calls internally; a manual run
requested during the scheduled fetch waits for it. Callers do not see the queue.

Credentials are held in memory only for the life of the batch and are never logged. Errors name the
Bitwarden item, never a value, as today.

## Batches and runs

Every scrape is a **run**, and runs are started in **batches**:

```ts
startBatch(
  requests: { bankKey: BankKey; params: RunParams }[],
  trigger: 'schedule' | 'manual',
): { started: Run[]; alreadyRunning: Run[] }
```

1. For each request, if that bank already has a run in progress it is not started, and that run is
   reported under `alreadyRunning` (see below). Otherwise a run is registered as `running` and takes
   the bank's lock.
2. Both lists are returned at once. Everything after this happens in the background.
3. The `config` row is loaded and `BankCredentialsService.fetch` is called **once**, with the bank
   keys of the whole batch.
4. The batch forks: each run with credentials goes to `ScrapeJob.run`, all concurrently. A run whose
   credentials failed is marked `failed` without a browser ever opening.
5. Each run ends on its own: `succeeded` or `failed`, lock released.

The scheduled tick is a batch of three. A manual call is a batch of one. There is no second code
path.

**Run id and directory.** `runId` is `<bankKey>-<YYYYMMDD-HHmmss-SSS>` (UTC-6), and it is also the
name of the run's directory, `projects/scrape-txs/storage/runs/<runId>/`, resolved from the package
directory rather than the working directory. The directory is created only when something is
written to it (a trace, a dry-run file).

**The registry** is in memory: the 50 most recent runs, newest first. It is lost on restart. Run
history is not a database table.

**A bank that is already running:**

- From the endpoint: `409 Conflict`, with the id of the run in progress.
- From the schedule: skipped, and logged as a warning. The other banks in the tick start normally.

## One bank's run (`ScrapeJob.run`)

Today's `run()`, minus what moved out:

1. Launch Chromium headless (see "Headless and the Playwright upgrade"), with
   `--deny-permission-prompts` as today.
2. Up to two attempts, each in a fresh context with tracing on. A retry inherits no cookies.
3. On the final failure, save the trace to `<run dir>/trace.zip`, then fail.
4. Close the context after every attempt, and the browser at the end, whatever happened.
5. Persist: the upsert and the deletes in one transaction, then the running balances. Unchanged.
6. With `dryRun`, write `<run dir>/scraped.json` instead and touch nothing in the database.

It returns counts: rows upserted, rows deleted, balances updated, and the dry-run file's path when
there is one.

## Headless and the Playwright upgrade

**Playwright** moves from 1.61.1 to the latest stable, pinned exactly as today, and its Chromium is
installed with `pnpm -C projects/scrape-txs exec playwright install chromium`.

**Headless** is not new for these banks: the retired Lambda ran them with `headless: true` for two
years. Only the local path was headed. Two details matter, both measured on the installed build:

- **Which headless.** Playwright has two. Its default is the *headless shell*, a cut-down build
  (it reports zero browser plugins). `channel: 'chromium'` selects Chromium's *new headless* mode,
  which is the full browser without a window (it reports five plugins, the fixed list a normal
  Chrome has; a headed launch was not measured).
  The scrapers are known to work in the full browser, so the service launches
  `chromium.launch({ headless: true, channel: 'chromium' })`.
- **The user agent.** Both headless modes announce themselves as `HeadlessChrome/<version>`, which
  is why the context has always overridden the user agent. That override stays, but it stops being a
  constant: today it claims Chrome 125 while the engine is 149, and it would drift further with each
  upgrade. It is built from the launched browser's own version instead, so it always reads
  `Chrome/<the real major>.0.0.0` on macOS.

**Order of work.** The upgrade and the switch to headless are done **first**, on the current CLI,
before any NestJS work, and proven with a real dry-run scrape (`--json`) of each of the three banks.
A bank that rejects the new browser then shows up as exactly that, not as a side effect of the
restructure. If a bank does fail headless, work stops and the owner decides.

## Isolation

What "one failing should not affect another" rests on:

| Shared? | |
| --- | --- |
| Chromium process | No. One per run. |
| Browser context | No. One per attempt. |
| Bitwarden session | Yes, per batch, and only before any browser opens. An item-level failure still fails one bank only. |
| Database pool | Yes. Each run writes in its own transaction on its own connection. |
| Errors | Each run's promise is caught inside the run. Nothing is rethrown to the scheduler or left as an unhandled rejection. The batch waits with `Promise.allSettled`. |

A restart of the service in the middle of a scrape aborts that scrape. Nothing is half-written,
because a run persists in a single transaction at its end.

## Schedule

`@nestjs/schedule` (12.x, which declares NestJS 12 support). One job:

```ts
@Cron('0 7 * * *', { timeZone: 'America/Guatemala' })
```

It calls `startBatch` with all three bank keys and default parameters, `trigger: 'schedule'`. 07:00
Guatemala is what the retired Lambda schedule used.

There is no catch-up. If the machine is asleep or the service is down at 07:00, that day's run does
not happen. The default-months rule already covers the gap: the next run rescrapes the current
month, and the previous month too through the 10th.

## REST

No authentication, same as `tx-payees`: a local service.

**`POST /scrape/:bankKey`**

```jsonc
// body — every field optional
{
  "months": ["2026-09", "2026-10"],   // YYYY-MM; default: current month, plus the previous one if today is the 10th or earlier
  "account": "904201043",              // scrape only this account of the bank
  "dryRun": true                       // write scraped.json instead of the database
}
```

- `202 Accepted` → the run (`runId`, `bankKey`, `trigger: "manual"`, `status: "running"`, `startedAt`,
  `params`).
- `400` → unknown bank key, a month that is not `YYYY-MM`, or an unknown body field.
- `409` → that bank is already running; the body carries the id of the run in progress.

An `account` that does not belong to the bank fails the **run** (reported by the `GET`), not the
request: accounts live in the `config` row, which is read in the background step.

**`GET /scrape/runs/:runId`** → the run:

```jsonc
{
  "runId": "bacGt-20261004-070000-012",
  "bankKey": "bacGt",
  "trigger": "schedule",
  "status": "failed",                  // running | succeeded | failed
  "startedAt": "…", "finishedAt": "…",
  "params": { "months": ["2026-10"], "dryRun": false },
  "result": null,                      // { upserted, deleted, balancesUpdated, dryRunPath? } when succeeded
  "error": { "message": "…", "stage": "scrape", "tracePath": "…/trace.zip" }   // when failed
}
```

`error.stage` is `credentials`, `scrape` or `persist`. `404` when the id is not in the registry.

**`GET /scrape/runs`** → the registry, newest first.

## Validation (`nestjs-zod`)

- DTO classes come from `createZodDto` over Zod schemas: the route parameter, the body, and the run
  response.
- `ZodValidationPipe` is registered globally (`APP_PIPE`), so params and bodies are validated before
  a controller method runs.
- `ZodSerializerInterceptor` is registered globally and the routes declare their response DTO, so
  what leaves the service is checked against the same schemas.
- Object schemas are strict: an unknown body field is a `400`, not silently dropped.

**Known risk.** `nestjs-zod` 5.5.0 declares `@nestjs/common ^10.0.0 || ^11.0.0` as its peer; NestJS
12 is not in the range, and there is no upstream issue about it. It is installed anyway, with the
peer mismatch allowed explicitly for that one package in `pnpm-workspace.yaml`. It is proven two
ways before anything is built on it: the service boots, and a request with a bad body gets a `400`
whose body is nestjs-zod's error format. The single-copy check from the `prepare-nestjs-app` skill
(`realpath` of `@nestjs/common` from the app and from `synced-utils/nestjs-utils`) must still pass.
If it does not work on NestJS 12, work stops and the owner decides.

## Alerts

One email per failed run, subject `Scrape bank txs failed for <bankKey>`, to `MAILER_ME`, as today.
The body carries the error message, the stage and the run id.

One exception: when a batch fails at the Bitwarden **session** step, every run in it failed for the
same reason, so one email is sent, naming all the banks.

A failure to send an alert is logged and changes nothing about the run's status.

## Logging

`StructuredLoggerModule.forRoot()` with no options: there is no inbound authentication and no
request body carries a secret. Every line a run logs carries `runId` and `bankKey`. The bank flows
receive the run's logger instead of calling `console.log`.

Credentials never reach a log line: they are passed as arguments, not put in log attributes, and
the Bitwarden wrapper's errors quote `bw`'s stderr, which names commands and items, not values.

## Wiring

- **Port.** bank-bots has no block in `~/Dev/reserved_port_ranges.txt`. Claim block 25
  (22250–22299) for it, move "Next free block" to 26, and give `scrape-txs` port **22250**, recorded
  in `devtooie.config.ts`. `tx-payees` (3001) and `web` (3002) sit outside the pool and are not
  moved here.
- **devtooie.** `scrape-txs` becomes `command: ['start', { watches: false }]` with that port and a
  `/status/health` healthcheck; `selectable: false` goes away. No watch mode: a reload in the middle
  of a scrape would kill it.
- **Dependencies.** Upgrade `playwright` (above). Add `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` (`^12`, the
  version `tx-payees` is on), `@nestjs/schedule`, `nestjs-zod`, `pino`, `reflect-metadata`, `rxjs`,
  `@types/express`, and `@rhyek/nestjs-utils` through `synced-utils add nestjs-utils -t
  projects/scrape-txs`. Remove `commander`.
- **tsconfig.** Aligned with `tx-payees` (decorator flags, `~/` alias), keeping the `DOM` lib the
  Playwright flows need for code that runs in the page.
- **Environment.** No new variables. `PORT` comes from devtooie; `DATABASE_URL`, `MAILER_*` and
  `BW_*` are the ones in use today.

## Documentation

- Root `CLAUDE.md`: the scraper section, "Running things", and the daily-schedule paragraph.
- `projects/scrape-txs/CLAUDE.md`: new, from the `prepare-nestjs-app` conventions, plus this
  service's modules and the isolation rules above.
- `.claude/skills/fix-scrape-bugs/SKILL.md`: reproducing a failure becomes a `POST` and a `GET`
  instead of the CLI command, and traces are found under `storage/runs/<runId>/`.
- `projects/scrape-txs/README.md`: the two `curl` commands.

## Testing

Specs are `*.spec.ts` with `test(...)`, run by `node --test`, with hand-built instances and fakes
passed through constructors, as in `tx-payees`.

- **`scrape-runs`** (fake credentials service, fake job):
  - a batch of three where one job rejects leaves the other two `succeeded`;
  - a bank already running is refused from the endpoint path and skipped from the schedule path,
    while the rest of the batch starts;
  - credentials are fetched once per batch, with all its keys;
  - an item-level credentials error fails only that run, with `stage: 'credentials'`, and its job is
    never called;
  - a session-level credentials error fails every run and sends one alert;
  - the lock is released after success and after failure;
  - the registry keeps the 50 newest runs.
- **`credentials`** (fake `bw` runner):
  - one session for several keys, in the order status → unlock → sync → get… → lock;
  - `lock` runs even when a `get` fails;
  - two overlapping `fetch` calls never interleave their commands;
  - a failing `get` yields an error for that key only.
- **DTOs:** a bad month, an unknown bank key and an unknown field are rejected; an empty body is
  accepted.
- **`months`:** the default rule on the 10th and the 11th.
- **`scrape-schedule`:** a tick asks for a batch of exactly the three bank keys.
- The existing `bitwarden` and `occurrences` specs keep passing.

Then against the real thing:

1. `pnpm -C projects/scrape-txs run typecheck` and `test`.
2. Boot under devtooie; `GET /status/health`; read a real log line.
3. `POST /scrape/nope` → `400` in nestjs-zod's format (the proof for the peer-range risk).
4. Three real `dryRun` scrapes, one per bank, posted at the same time and each followed to
   `succeeded` with the `GET`. They log into the banks and write nothing to the database; a failure
   sends the usual alert email. Together with the three CLI dry runs done right after the Playwright
   upgrade, that is two logins per bank for the whole job.

## Out of scope

- Any change to how a bank's site is scraped.
- Run history in the database.
- Authentication on the endpoints.
- Catching up a missed tick.
- Moving `tx-payees` and `web` into the port pool.
- A switch to run a scrape headed for debugging. A failed run's trace already holds screenshots and
  DOM snapshots of every step.

## Implementation notes

What changed between this document and the build. The sections above are left as they were
approved; where they disagree with this list, this list is what was built.

**Run history is a table, not memory** (the owner's decision, mid-build). The in-memory registry of
the 50 newest runs became the `scrape_run` table (migration `0017_scrape_run`): `id` uuidv7,
`bank_key`, `trigger`, `status`, `started_at`, `finished_at`, `months`, `account`, `dry_run`,
`result`, `error`. Consequences:

- `runId` is the row's uuidv7, not `<bankKey>-<timestamp>`; the run directory is still
  `storage/runs/<runId>/`. A `runId` that is not a uuid is a `400`.
- `startBatch` is async and stores the runs before it returns. If they cannot be stored, nothing is
  started and the bank locks are released; a scheduled tick in that state sends one alert.
- The per-bank lock is still in memory. A row left `running` by a process that stopped is marked
  `failed` on the next boot.
- `GET /scrape/runs` returns the 50 newest rows.

**Months come from history** (same decision). The spec's "Schedule" section claimed the
default-months rule covers a missed tick. It does not for a gap that crosses a month end and runs
past the 10th: last good run Oct 28, next run Nov 11, and Oct 29–31 are never scraped. So, when no
months are requested (scheduled or manual), a run covers every month from **10 days before the
bank's last successful full scrape** through the current month, and never fewer than the old rule.
"Successful full scrape" = `succeeded`, not a dry run, no `account` filter, and it covered the month
it ran in. The 10 days are the late-posting allowance the old "through the 10th" rule stood for.
There is still no catch-up of the missed tick itself.

That reach is **capped at four months** (the current one and the three before it). BAC's statement
picker only offers recent months, and a run that asks for one it no longer offers fails, which would
leave the last success where it was and make every later run fail the same way. Months beyond the
cap are not scraped; the run warns and emails the owner the list with the request that backfills
them. Months requested explicitly are never capped.

**A fourth error stage, `config`.** A `config` row that cannot be read fails the whole batch with
one alert, before Bitwarden is touched; an `account` that is not the bank's fails its run at this
stage, without opening a browser. (Before, an unknown account silently scraped nothing.)

**`CredentialsResult` carries a `scope`** (`session` | `item`), which is how the batch tells "Bitwarden
could not be opened" (one alert, every run failed) from "this bank's item is broken".

**`startBatch` also returns `done`**, a promise that settles when every started run has ended. The
scheduled tick awaits it; the endpoint ignores it.

**The CLI dry runs after the Playwright upgrade** were run with `devtooie cmd -p scrape-txs -c start`
(the `--log-dir` option the docs described no longer exists), one bank at a time. All three passed
headless on the first attempt, on Chromium 153, and September's row counts matched the database on
every account.

**What `nestjs-zod` needed on NestJS 12:** nothing beyond allowing its peer range. It was proven
with a throwaway app before anything was built on it, and again on the real service.

**Not done here:** the owner's running devtooie session was started before `scrape-txs` had a port,
so it does not run the service; it picks it up the next time the session is started.
