---
name: fix-scrape-bugs
description: >-
  Diagnose and fix a failing bank-transaction scraper in this repo (projects/scrape-txs;
  banks bacGt, bacCr, bancoIndustrialGt). Use this WHENEVER a scheduled scrape fails, a
  "Scrape bank txs failed for <bank>" alert/email arrives, or the user asks you to look at a
  Playwright trace file, a scraper log, or a `storage/runs/<runId>/trace.zip`, or says a bank
  "stopped scraping", "isn't pulling transactions", "is broken", or "is timing out". The
  scrapers break when a bank changes its website DOM, so the job is: read the trace + logs to
  find the failing step, reproduce it yourself, inspect the live page / trace DOM to find the
  new selector or flow, fix the Playwright code, and re-run until transactions scrape. Drive it
  end-to-end autonomously — don't just report the diagnosis, fix it.
---

# Fixing bank scraper bugs

The scrapers in `projects/scrape-txs` log into banks with Playwright and pull transactions into
Postgres. They break when a bank redesigns its site and a selector or navigation step no longer
matches — the run then hangs on a locator until Playwright times out (default 30 s). Your job is
to turn a failure (an alert, a trace, or "bank X is broken") into a **working scrape** by
diagnosing from the trace, reproducing, fixing the code, and iterating until it succeeds.

The whole point is that you can do this **autonomously**. Don't stop at "here's the diagnosis" —
carry it through to a green run. Only stop to ask the human when you hit something you genuinely
can't decide or do (see [When to stop](#when-to-stop-and-ask)).

## Orientation — where things are

| Thing | Path / value |
| --- | --- |
| Scraper service (NestJS) | `projects/scrape-txs` — see its `CLAUDE.md` |
| Per-bank Playwright code | `projects/scrape-txs/src/scrape/banks/<bank>/scrape.ts` (`bac/`, `banco-industrial/`) |
| One bank's run (browser, retries, tracing, persistence) | `projects/scrape-txs/src/scrape/scrape-job.service.ts` |
| Batches, the per-bank lock, alerts | `src/scrape/scrape-runs.service.ts`, `src/scrape/scrape-alert.service.ts` |
| Credentials (Bitwarden) | `src/credentials/` |
| Bank keys | `bacGt`, `bacCr` (share the BAC code in `bac/scrape.ts`), `bancoIndustrialGt` |
| Start a scrape | `POST http://localhost:22250/scrape/<bankKey>` (port from `devtooie.config.ts`) |
| Follow a run | `GET /scrape/runs/<runId>`; recent runs: `GET /scrape/runs` (the `scrape_run` table) |
| A run's files | `projects/scrape-txs/storage/runs/<runId>/` — `trace.zip` (failure only), `scraped.json` (dry run only) |
| Service log | the devtooie session's logfile (`devtooie logs`), JSON lines; every line of a run carries `run.runId` + `run.bankKey` |
| DB | Supabase Postgres, tables `bank_tx` + `bank_account` + `scrape_run`; `DATABASE_URL` in repo-root `.env.local` |

`scrape-job.service.ts` runs a bank with **retries** (currently 2 attempts), each in a **fresh
browser context**, headless. On the final failure it saves a Playwright trace to
`storage/runs/<runId>/trace.zip`; the run is stored as `failed` with the error, the stage it stopped
at (`config`, `credentials`, `scrape`, `persist`) and the trace path, and a
`Scrape bank txs failed for <bank>` alert is emailed. That trace + the run's log lines are your
primary evidence — and `GET /scrape/runs/<runId>` hands you the error and the trace path directly.

## The loop

1. **Gather evidence** — get the trace file and the log for the failing run.
2. **Diagnose from the trace** — find the exact action that hung and the selector/URL involved.
3. **Reproduce** — run the scrape yourself and confirm you get the *same* failure.
4. **Confirm from your own trace** — inspect the trace *your* run produced; verify the failing
   step and DOM match the original. Now you're debugging a live, current failure, not a stale one.
5. **Find the fix** — inspect the current DOM (live page for public pages, trace snapshots for
   authenticated ones) to learn what the selector/flow should be now.
6. **Fix the code**, **re-run**, and **iterate** — one bank change often breaks several steps in
   sequence; keep going until transactions actually land in the DB.
7. **Document** what you learned back into this skill.

### 1 & 2 — Gather evidence and diagnose from the trace

Read the **run's error** first for the headline (`GET /scrape/runs/<runId>`, or its `scrape run
failed` log line): it names the timed-out `locator.click`/`locator.fill` and its Playwright **Call
log** (`waiting for locator('…')`). The earlier attempt's error is in the log as `scrape attempt
failed; retrying` (`reason`). That single line usually tells you which selector died.

Then open the **trace** for the full picture. Traces are zip files of newline-delimited JSON; a
short `jq` cookbook for extracting everything useful — the action timeline, per-action durations
(a duration ≈ the timeout is the hung step), Playwright Call logs, page-navigation URLs, DOM
snapshots, and console output — is in **`references/trace-analysis.md`**. Read that file and use
its recipes; don't reinvent them.

Key diagnostic signal: **an action whose duration ≈ the Playwright timeout (30000 ms) and whose
Call log shows only `waiting for locator(...)` never resolved** — that locator is the break. The
actions *before* it succeeded (fast durations), so the DOM changed at exactly that step.

### 3 — Reproduce

Scrapes are started over HTTP. First make sure the service is up — **check, don't start a devtooie
session** (the `devtooie` skill explains why: a new session shuts the owner's running one down):

```bash
curl -s localhost:22250/status/health          # {"status":"ok"} when it is up
```

If it is not up and the owner has a devtooie session running without it, run just this package next
to that session, in the background, and stop it afterwards **by the PID you started**:

```bash
pnpm devtooie cmd -p scrape-txs -c start       # PORT and the .env files are injected
```

Then run the failing bank and follow it:

```bash
curl -s -X POST localhost:22250/scrape/<bankKey> -H 'content-type: application/json' \
  -d '{"dryRun": true}'                        # -> 202 with the run; note its runId
curl -s localhost:22250/scrape/runs/<runId>    # running | succeeded | failed (+ error, tracePath)
```

Body fields, all optional: `months` (`["2026-09"]`; default: since the bank's last successful
scrape), `account` (one account number of that bank), `dryRun` (write
`storage/runs/<runId>/scraped.json` instead of the database). **Reproduce with `dryRun: true`**
unless you specifically need the write: the login and the scrape are identical, and no transaction
is written (`bank_tx` is untouched; the run itself is still recorded in `scrape_run`). A `409` means that bank already has a run in progress — follow that run instead.

What happens:
- The service fetches the bank's credentials from Bitwarden and logs in with them in a headless
  Chromium — that's the scraper doing it, which is fine. **You never type credentials yourself**
  (prohibited).
- A failing run **sends the failure alert email** (to the owner's own address) — expected, same as
  the scheduled runs. Not a new side effect to worry about.
- A BAC failure can take ~3–4 min (two attempts, each with 30 s timeouts, plus a slow site on
  retry). Poll the run; don't restart the service while it is running, that aborts it.
- Code changes need a **restart of the service** to take effect (it does not watch files):
  `POST /command/restart/scrape-txs` on the devtooie control API, or stop and start your own
  `devtooie cmd` process.

Confirm the run's error matches the original diagnosis. Consistency matters: if your run fails
differently every time, suspect flakiness/throttling rather than a DOM change — say so and dig in.

### 4 — Confirm from your own trace

Inspect the trace your run just produced (`error.tracePath` on the run:
`storage/runs/<runId>/trace.zip`) with the same recipes. Verify the failing action, selector, and page URL match what you saw originally, and
look at that page's **DOM snapshot** in the trace to confirm the element really is gone/renamed.
This is what turns "I read an old trace" into "I've reproduced the current failure and seen the
live DOM."

### 5 — Find the fix

Figure out what the step *should* be now:

- **Public / pre-login pages** (home page, country selector, login form): inspect the **live
  page** with the Claude-in-Chrome browser tools. Navigate to the URL, and use `javascript_tool`
  / `read_page` to find the element that replaced the broken one — check whether the old selector
  still matches (`document.querySelector('…')`), then locate the real control by role/text/id and
  read its attributes. A screenshot helps you see which control is the right one. **Do not log in**
  — never enter credentials, never click a submit that would sign in with saved credentials. The
  browser may autofill the user's saved credentials; don't read or submit them.
- **Authenticated pages** (post-login dashboards, account/transaction views): you can't reach
  these live without logging in, so use the **DOM snapshots inside the trace** (the scraper
  captured them while logged in). Extract the snapshot for the relevant `frameUrl` and find the
  new selector there (see `references/trace-analysis.md`).

Prefer **stable, meaningful selectors**: an `id`, or a role+accessible-name (`getByRole('button',
{ name: '…' })`), over brittle utility classes. Note any behavior the element needs — e.g. a login
button whose `onclick` runs setup functions must be **clicked**, not bypassed with `form.submit()`.

### 6 — Fix, re-run, iterate

Apply the smallest correct change to the bank's `scrape.ts` (or `scrape-job.service.ts` if the bug
is in the run/retry machinery, not a selector). Restart the service, re-run (step 3) and watch where
it gets to:

- **Fails at a later step** → the same site change broke multiple steps. Diagnose the new failure
  from the new trace and fix it too. Repeat.
- **Succeeds** → the run reads `succeeded` with its counts (`upserted`, `deleted`,
  `balancesUpdated`), and **no** trace is saved. Finish with one run without `dryRun`, then verify
  in the DB (below).

Keep iterating until the bank actually scrapes. Typecheck and test as you go (`pnpm -C
projects/scrape-txs run typecheck`, `pnpm -C projects/scrape-txs test`).

### Verify success in the DB

`succeeded` means it ran, but confirm rows actually updated. Query Postgres:

```bash
export PGURL=$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"')
psql "$PGURL" -P pager=off -c "
SELECT a.bank_key, a.account_number, count(*), max(t.date) AS last_tx_date, max(t.created_at) AS last_insert
FROM bank_tx t JOIN bank_account a ON a.id = t.bank_account_id
WHERE a.bank_key = '<bankKey>' GROUP BY 1, 2;"
psql "$PGURL" -P pager=off -c "
SELECT status, trigger, months, dry_run, started_at, result, error
FROM scrape_run WHERE bank_key = '<bankKey>' ORDER BY started_at DESC LIMIT 5;"
```

Note the scraper **upserts** and only re-sets `amount_cents` on conflict, so re-scraping
already-present transactions won't bump `created_at` — to prove a *fresh* insert you need a
transaction that isn't in the DB yet; otherwise trust the run's `succeeded` + its counts + the
absence of a trace.

### 7 — Document

When you learn something durable — a new selector a bank moved to, a login-flow quirk, a
retry-machinery gotcha, a better trace query — add it to this skill (the
[Known failure modes](#known-failure-modes--history) section below, or the reference cookbook).
The next failure should be faster because you wrote down this one.

## When to stop and ask

Drive autonomously, but stop and check with the human when:

- The fix requires **entering credentials, solving a CAPTCHA, or completing a 2FA/OTP/token** step
  — you can't and won't do these. Report what's blocking.
- The bank added a genuinely interactive challenge (SMS code, device approval) the scraper can't
  clear headlessly.
- You'd need to change **what data is written** (schema, which accounts/months) rather than fix a
  selector/flow — that's a product decision.
- After a few genuine iterations you're not converging (e.g. the site is anti-bot throttling every
  attempt), so more automated retries won't help.

## Known failure modes & history

Concrete breakages seen on these scrapers — check here first when a symptom looks familiar.

### BAC (`bacGt` / `bacCr`) — login submit button renamed — FIXED 2026-07-11
- **Symptom:** attempt fills Usuario + Contraseña fine, then `locator.click` on
  `.login-form__submit-btn` hangs 30 s (`waiting for locator('.login-form__submit-btn')`).
- **Cause:** BAC redesigned the online-banking login page
  (`sucursalelectronica.com/redir/showLogin.go`); the submit button is now
  `<button id="confirm" name="confirm" class="btn btn-primary">Ingresar</button>`. Its `onclick`
  runs `initializeDigitalSignature(); copyTempPass(); saveUserCache()`, so it must be **clicked**
  (not `form.submit()`ed). Fix applied in `bac/scrape.ts`:
  `page.locator('.login-form__submit-btn')` → `page.locator('#confirm')`.
- **Key learning:** this was the *only* broken step. The **post-login flow was completely
  unaffected** — account navigation (`.bel-card`, the account-row form button), the month picker
  (`#selectMonthLabel` / `#selectMonthList`), and the transaction table (`#transactionTable1`) all
  still worked. The redesign hit only the marketing/login site, not the online-banking app (the
  `ebac` module). So when a BAC login step breaks, fix it and re-run before assuming the whole app
  changed — the authenticated area is a separate, more stable system.

### BAC retries — stale context redirects the country step — FIXED 2026-07-11
- **Symptom:** attempt 1 fails at login; attempt 2 fails *earlier and differently* —
  `locator.click` on `[data-country]` filtered to the country times out 30 s.
- **Cause:** the run loop (then `run.ts`) reused **one browser context** across retries, so the country-preference
  **cookie** from attempt 1 persisted. On retry, `goto('https://www.baccredomatic.com/')`
  **redirected to the country page** (e.g. `/es-gt`), which has no `[data-country]` selector, so the
  click never resolved — the retry mechanism was effectively dead.
- **Fix applied:** the run loop (now `scrape-job.service.ts`) creates a **fresh `browser.newContext()` inside the retry loop**
  (one per attempt, closed in the loop's `finally`), and starts tracing per-context, saving the
  trace only on the final attempt. Each retry therefore starts with no cookies/storage.
- **Watch for the general pattern:** whenever attempt 2 fails at a step attempt 1 *passed*, suspect
  leaked session state — compare the `goto` landing URLs across attempts in the trace.

### An account times out in the account list — may be a credentials/config mismatch, not a DOM change
- **Symptom:** login and the *first* account scrape succeed, then `locator.click` on another
  account's row (`getByRole('cell', { name: '<accountNumber>' })` inside the `Cuentas bancarias`
  card) times out 30 s.
- **Not necessarily a DOM change.** It often just means the configured account **isn't listed in
  that login** — it was added to the wrong bank key, or the bank credentials point at a login that
  doesn't include it. The account-number format is a tell (a `CR…` IBAN under a Guatemala login is
  suspicious). Seen 2026-07-11: `CR07…902868` was configured under `bacGt` but the then-current
  bacGt credentials' login didn't list it; the fix was the owner swapping bacGt to a login that
  does, **not** a scraper edit.
- **Resolve by** confirming the account is reachable from that login. If not, it's a
  **config/credentials change** (move it to the right bank key, or the owner updates the stored bank
  credentials) — credentials are owner-only (see [When to stop](#when-to-stop-and-ask)).

### Login rejected — check Bitwarden before the scraper — 2026-10-01
- **Symptom:** the bank refuses the login on the first attempt, with no selector timeout before it.
- **Cause seen:** the stored Banco Industrial password was stale. Credentials now come from Bitwarden
  per batch (`src/credentials/`; see CLAUDE.md → `config`), so the fix is the owner updating the
  item in Bitwarden — never a scraper edit. **Do not re-run a bank whose login was rejected**: each
  run makes two attempts and repeated failures can lock the user.
- A run that failed with `stage: "credentials"` stopped before any browser opened (bad bot API key
  or master password, item missing, `bw` not on `PATH`). When Bitwarden itself could not be opened,
  every bank of the batch fails together and ONE alert names them all.

### BAC month picker read too early → an empty month — FIXED 2026-10-01
- **Symptom:** a run scrapes **zero** rows for a month that has plenty (seen: July for `904201043`,
  127 rows on the next run two minutes later). The scrape treats "not scraped" as "the bank deleted
  it", so this would have wiped the stored month; it only didn't because the same run crashed on
  the insert below.
- **Cause:** after picking a month the code waited a random delay and read `#transactionTable1`
  without confirming the table had switched.
- **Fix applied:** `readStatementRows()` in `bac/scrape.ts` polls until every row is dated inside
  the requested month (or the bank's "No hay detalle de movimientos" row shows) and two reads agree;
  and a month that scrapes empty while the DB has rows for it now throws instead of deleting.

### Upsert aborts: "ON CONFLICT DO UPDATE command cannot affect row a second time" — FIXED 2026-10-01
- **Cause:** the bank lists two transactions identical on account, date, doc no, description and
  amount (BAC doc numbers are generic; seen with two same-day PedidosYa tips). The batched upsert
  cannot hold both, and the whole transaction rolls back — nothing is written for that bank.
- **Fix applied:** `bank_tx.occurrence` (migration 0014) is now part of `bank_tx_unique_cols`. Each
  scraper passes an account's rows through `numberOccurrences()` (`src/scrape/banks/occurrences.ts`), which
  numbers identical rows 1, 2, … in statement order, so every copy is stored and a re-scrape lands on
  the same rows. A new scraper path must call it before computing deletes.
- **Completeness check that works:** compare `bank_account.running_balance_cents` with
  `SUM(bank_tx.amount_cents)` for the account. It is only meaningful for an account whose balance
  was refreshed in that run (one with rows in the current month).

### Diagnosing tips that generalize
- Trust **durations + the Playwright Call log + stdout error** to find the hung step. Don't rely
  only on extracting the structured `error` from trace `after` entries — its shape varies across
  Playwright versions and may read as "ok" even for the timed-out action.
- **Only the *final* attempt's trace is saved.** The job discards earlier attempts' traces, so when
  retries fail at *different* steps (e.g. attempt 1 fails deep in the account list, attempt 2 fails
  at *login* because the bank throttled the rapid re-login), the saved trace shows the later,
  less-informative failure — not the one you care about. The **service log keeps every attempt's
  error** (`scrape attempt failed; retrying`, with `reason`) — read those first; if attempt 1 was the interesting
  failure but its trace is gone, re-run to recapture it (narrowing to the one account with the
  `account` body field, or accept that the retry may fail differently the second time).
- Compare **`frame-snapshot` `frameUrl`s across attempts** to catch redirects / unexpected
  navigation (that's how the stale-context bug surfaced).
- The fills succeeding but the *next* click hanging is the classic "one selector moved" signature.
