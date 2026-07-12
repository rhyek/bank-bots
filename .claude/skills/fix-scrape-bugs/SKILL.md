---
name: fix-scrape-bugs
description: >-
  Diagnose and fix a failing bank-transaction scraper in this repo (projects/scrape-txs;
  banks bacGt, bacCr, bancoIndustrialGt). Use this WHENEVER a scheduled scrape fails, a
  "Scrape bank txs failed for <bank>" alert/email arrives, or the user asks you to look at a
  Playwright trace file, a scraper log, or a `storage/playwright-traces/*.zip`, or says a bank
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
| Scraper package | `projects/scrape-txs` |
| Per-bank Playwright code | `projects/scrape-txs/src/lib/<bank>/scrape.ts` (`bac/`, `banco-industrial/`) |
| Run orchestration (retries, tracing) | `projects/scrape-txs/src/lib/run.ts` |
| CLI entry (email-on-failure) | `projects/scrape-txs/src/console.ts` |
| Bank keys | `bacGt`, `bacCr` (share the BAC code in `bac/scrape.ts`), `bancoIndustrialGt` |
| Saved traces (on failure only) | `--trace-dir` if passed, else `projects/scrape-txs/storage/playwright-traces/<ts>_<bankKey>.zip` |
| Run logfiles (stdout+stderr) | `--log-dir` if passed, else `node_modules/.devtooie/logs/<ts>.log` |
| Coupled per-run dir (recommended) | `storage/scrape-txs/run/<bankKey>-<id>/` — holds both the log and the trace |
| DB | Supabase Postgres, table `bank_txs`; `DATABASE_URL` in repo-root `.env.local` |

`run.ts` runs each bank with **retries** (currently 2 attempts) inside **one browser context**,
and on any error escaping the loop it saves a Playwright trace to `storage/playwright-traces/`
before re-throwing. `console.ts` then emails a `Scrape bank txs failed for <bank>` alert. That
trace + the run logfile are your primary evidence.

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

Read the **run logfile** first for the headline: the `Attempt N failed with error:` lines and the
final thrown error name the timed-out `locator.click`/`locator.fill` and its Playwright **Call
log** (`waiting for locator('…')`). That single line usually tells you which selector died.

Then open the **trace** for the full picture. Traces are zip files of newline-delimited JSON; a
short `jq` cookbook for extracting everything useful — the action timeline, per-action durations
(a duration ≈ the timeout is the hung step), Playwright Call logs, page-navigation URLs, DOM
snapshots, and console output — is in **`references/trace-analysis.md`**. Read that file and use
its recipes; don't reinvent them.

Key diagnostic signal: **an action whose duration ≈ the Playwright timeout (30000 ms) and whose
Call log shows only `waiting for locator(...)` never resolved** — that locator is the break. The
actions *before* it succeeded (fast durations), so the DOM changed at exactly that step.

### 3 — Reproduce

Run the failing bank yourself, from the repo root, putting **the log and the trace in one
per-run directory** so they stay coupled. The scraper takes `--trace-dir` (where it saves the
trace on failure) and devtooie's `cmd` takes `--log-dir` (where it writes the stdout/err log):

```bash
RUN_DIR="$PWD/storage/scrape-txs/run/<bankKey>-$(date +%Y%m%d-%H%M%S)"   # any unique, sortable id
pnpm devtooie cmd scrape-txs -c start --log-dir "$RUN_DIR" -- --bank-key <bankKey> --trace-dir "$RUN_DIR"
```

**Use absolute paths for `RUN_DIR`.** This is a real gotcha: `devtooie` resolves `--log-dir`
relative to its own cwd (the repo root), but the scraper resolves `--trace-dir` relative to *its*
cwd (`projects/scrape-txs`, because `cmd` runs the child there). The *same relative string* would
therefore split the log and trace into two different directories. An absolute `RUN_DIR` (e.g.
`$PWD/…` from the repo root) removes the ambiguity — both processes write to the exact same dir.
Everything after `--` goes to the scraper; `--log-dir`/`-c`/`-p` before `--` go to devtooie.

What happens:
- Runs the scraper in its package dir with the resolved `.env` (so `DATABASE_URL` etc. are
  present), forwards `--bank-key`/`--trace-dir` to it, streams to stdout, **writes the logfile** to
  `$RUN_DIR/<ts>.log`, and on failure **saves the trace** to `$RUN_DIR/<ts>_<bankKey>.zip` — both
  together.
- Runs a real browser and logs in with the real credentials from the DB config — that's the
  scraper doing it, which is fine. **You never type credentials yourself** (prohibited).
- A failing run **sends the failure alert email** (to the user's own address) via `console.ts` —
  expected, same as the scheduled runs. Not a new side effect to worry about. (This is also why,
  when you just want to prove trace-saving/`--trace-dir` routing without emailing, you can call
  `run(months, bankKey, traceDir)` directly with a bogus bank key — it bypasses `console.ts`, so
  no email; the bogus key throws after the browser/trace start, saving a trace.)
- A BAC failure can take ~3–4 min (two attempts, each with 30 s timeouts, plus a slow site on
  retry). Give it a generous timeout and don't kill it early.

The simpler `pnpm devtooie cmd scrape-txs -c start -- --bank-key <bankKey>` still works and uses
the defaults (log → `node_modules/.devtooie/logs/<ts>.log`, trace →
`projects/scrape-txs/storage/playwright-traces/`), but then the two aren't colocated.

Confirm the stdout error matches the original diagnosis. Consistency matters: if your run fails
differently every time, suspect flakiness/throttling rather than a DOM change — say so and dig in.

### 4 — Confirm from your own trace

Inspect the trace your run just produced (newest zip in `storage/playwright-traces/`) with the
same recipes. Verify the failing action, selector, and page URL match what you saw originally, and
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

Apply the smallest correct change to the bank's `scrape.ts` (or `run.ts` if the bug is in the
run/retry machinery, not a selector). Then re-run (step 3) and watch where it gets to:

- **Fails at a later step** → the same site change broke multiple steps. Diagnose the new failure
  from the new trace and fix it too. Repeat.
- **Succeeds** → you'll see `Inserting/updating N <bank> transactions...` then `Done.` and exit
  code 0, with **no** trace saved. Verify in the DB (below).

Keep iterating until the bank actually scrapes. Typecheck as you go (`pnpm -C projects/scrape-txs
run typecheck`).

### Verify success in the DB

`Done.` means it ran, but confirm rows actually updated. Query Postgres:

```bash
export PGURL=$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"')
psql "$PGURL" -P pager=off -c "
SELECT bank_key, count(*), max(date)::date AS last_tx_date, max(created_at) AS last_scraped
FROM bank_txs WHERE bank_key = '<bankKey>' GROUP BY bank_key;"
```

`last_scraped` should be ~now. Note the scraper **upserts** and only re-sets `amount` on conflict,
so re-scraping already-present transactions won't bump `created_at` — to prove a *fresh* insert you
may need a transaction that isn't in the DB yet, or just trust `Done.` + the absence of a trace +
the run logfile showing the accounts/months processed.

**If the scraper had been broken for a while, `bank_txs` isn't the end of the job.** Those missed
months were also never synced downstream (to YNAB), and the YNAB sync only picks up the
current/previous month — so catching up the DB does **not** backfill the gap onward. After the DB
is current, backfill the affected account with `update-ynab/cmd/backfill` (per-account, any start
month). See CLAUDE.md → "update-ynab" for the exact command. So the real done-condition after a long
outage is: scrape → DB current → **backfill downstream** → verify in the budget app.

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
- **Cause:** `run.ts` reused **one browser context** across retries, so the country-preference
  **cookie** from attempt 1 persisted. On retry, `goto('https://www.baccredomatic.com/')`
  **redirected to the country page** (e.g. `/es-gt`), which has no `[data-country]` selector, so the
  click never resolved — the retry mechanism was effectively dead.
- **Fix applied:** `run.ts` now creates a **fresh `browser.newContext()` inside the retry loop**
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

### Diagnosing tips that generalize
- Trust **durations + the Playwright Call log + stdout error** to find the hung step. Don't rely
  only on extracting the structured `error` from trace `after` entries — its shape varies across
  Playwright versions and may read as "ok" even for the timed-out action.
- **Only the *final* attempt's trace is saved.** `run.ts` discards earlier attempts' traces, so when
  retries fail at *different* steps (e.g. attempt 1 fails deep in the account list, attempt 2 fails
  at *login* because the bank throttled the rapid re-login), the saved trace shows the later,
  less-informative failure — not the one you care about. The **run logfile keeps every attempt's
  error** (`Attempt N failed with error: …`) — read those first; if attempt 1 was the interesting
  failure but its trace is gone, re-run to recapture it (temporarily narrowing to the one account,
  or accept that the retry may fail differently the second time).
- Compare **`frame-snapshot` `frameUrl`s across attempts** to catch redirects / unexpected
  navigation (that's how the stale-context bug surfaced).
- The fills succeeding but the *next* click hanging is the classic "one selector moved" signature.
