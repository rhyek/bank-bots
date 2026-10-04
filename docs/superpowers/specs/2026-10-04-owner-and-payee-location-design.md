# Location for payees and transactions

**Date:** 2026-10-04
**Component:** `projects/tx-payees`, `projects/db`
**Status:** approved and implemented on 2026-10-04. Where the build departs from this document,
"Implementation notes" at the end says how and why.
**Supersedes:** `2026-07-19-payee-country-design.md` (never implemented)

## Goal

Record two different facts about place, and keep them apart:

- **Where a payee is.** A hotel in Costa Rica is in Costa Rica. Amazon is in the US, wherever it was
  ordered from.
- **Where the owner was when a purchase happened.** Often the same place as the payee (a restaurant
  in Costa Rica), often not (Amazon ordered from Guatemala).

Both are nullable. Both are worked out by `tx-payees` as part of processing a transaction, for every
transaction — including the ones the exact and rule tiers resolve without the AI payee matcher.

## Decisions taken with the owner

| Question | Decision |
| --- | --- |
| What does a transaction's location mean? | Where the owner was, from their own location history. Never "where the card was used". |
| How far back? | Transactions dated from 2026-01-01 and the payees they use. Same boundary as the payee sweep. |
| Where is the AI? | It resolves **days**, once per day. Transactions look their day up without AI. |
| Brands that bill through several countries (Uber via NL, GT, CR)? | One payee per brand. Split only for a genuinely separate local account (Claro / Claro CR), as today. |

The last row reverses the July spec, which split such payees per billing country. The transaction's
own location now carries the information that split was trying to preserve.

## Why days, not transactions

"Where was the owner" is a property of a date, not of a charge. Resolving it per transaction would
cost about 1,335 agent calls for 2026 and let two charges from the same day disagree. Resolving it
per day costs about 20-25 calls (days are resolved in runs) and gives one answer per day that every
transaction shares.

It needs judgment, not just a lookup, because the location history is unreliable in a specific way
(see `projects/tx-payees/CLAUDE.md`, "Location history"):

- Since 2026-08 the points come from a live tracker: real, but sparse, with whole days missing.
- Before that they come from a Google Timeline import that fills a day it has no data for with 96
  copies of its last known coordinate. In 2026 that filler placed the owner in San José on
  2026-01-08..28 and 2026-05-03..07 while their card was in daily in-person use in Guatemala City.

So the day resolver weighs two kinds of evidence: tracker days (trusting observed ones, discounting
`assumed` ones) and card charges that name a place. A supermarket, petrol or pharmacy charge is
strong evidence of presence.

## Data model

Migration `0015` in `projects/db`.

### `payee` — three nullable columns

| Column | Type | Meaning |
| --- | --- | --- |
| `country` | text | ISO 3166-1 alpha-2 code of where the business is |
| `location` | text | The specific place, free text, when there is exactly one |
| `location_kind` | text | `local` \| `chain` \| `remote` \| `unknown`; `NULL` = not looked up yet |

| Kind | Meaning | `country` | `location` |
| --- | --- | --- | --- |
| `local` | one physical place | set | set, e.g. `Las Catalinas, Guanacaste` |
| `chain` | several branches in one country | set | null |
| `remote` | online or global | head-office country | null |
| `unknown` | looked up, not determinable | null | null |

`location_kind` is the terminal marker: the payee location matcher runs only for `NULL`. To re-ask,
set it back to `NULL` by hand.

### `bank_tx` — two nullable columns

| Column | Type | Meaning |
| --- | --- | --- |
| `country` | text | ISO alpha-2 code of where the owner was at the time of purchase |
| `location` | text | The place within it, as resolved for that day |

Neither is part of `bank_tx_unique_cols`, and the scraper never writes them.

### `owner_day_location` — new table, one row per calendar day (UTC-6)

| Column | Type | Meaning |
| --- | --- | --- |
| `date` | date, PK | the day |
| `country` | text, null | ISO alpha-2 |
| `location` | text, null | city or area |
| `basis` | text | `observed` (tracker), `inferred` (from charges, or overriding an assumed tracker day), `unknown` |
| `confidence` | text | `high` \| `medium` \| `low` |
| `provisional` | boolean | true until the day is 10 days old (see below) |
| `data` | jsonb | the evidence shown to the resolver and its one-line reason |
| `created_at`, `updated_at` | timestamptz | |

Not replicated to SQLite: only the owner-location module reads or writes it, directly in Postgres.

### Audit

- **Day decisions** are self-describing (`owner_day_location.data`).
- **Transaction decisions**: a `matcher_result` row of a new `type = 'location'`, with
  `data = { purchaseDate, rule, country, location, final }`. `rule` names which of the three lookup
  rules below decided it.
- **Payee decisions**: new table `payee_location_result` (`id` uuidv7, `payee_id`, `kind`, `country`,
  `location`, `data` jsonb with the agent's summary and confidence, timestamps).

### Replica

`payee.country/location/location_kind` and `bank_tx.country/location` are added to the SQLite
replica schema, and `EXPECTED_SCHEMA_VERSION` goes to 3. The replica needs them so the sweep can
select work and `search_payees` can show a candidate payee's place.

## Components (`projects/tx-payees/src`)

```
location/            exists — Dawarich client, per-day tracker cache, `assumed` detection
owner-location/      NEW
  day-evidence.ts            pure: tracker lines + place-naming charges for a run of days
  day-location-resolver.ts   AI: resolves a run of days (abstract token + Agent SDK implementation)
  tx-location.ts             pure: picks a transaction's purchase day from resolved days
  owner-location.service.ts  ensureDays(dates), locate(tx, payee)
payee-location/      NEW
  payee-location-matcher.ts  AI + WebSearch (abstract token + Agent SDK implementation)
  prompt.ts, output-schema.ts
payee-resolver/      changed — orchestrates the per-transaction order below
```

Each AI component follows the existing `TxAiResolver` pattern: an abstract class as the injection
token, an Agent SDK implementation, and a stub in tests. Each has its own prompt and output schema.

### Day location resolver (AI, no tools)

- **Unit of work:** a run of consecutive days that are unresolved, or provisional and resolved more
  than 24 hours ago. At most 14 days per call.
- **Input:**
  - tracker lines for the run and three days either side, each marked observed, assumed or missing
    (from the existing `LocationService`);
  - card charges whose description carries a place field (25- or 30-character shapes), dated from
    the first day of the run to five days after its last day, with the payee's `location_kind` when
    known so remote payees can be discounted.
- **Output:** for every requested date exactly once: `country`, `location`, `basis`, `confidence`,
  `reason`. A response that omits or repeats a date is a failed run, not a partial write.
- **Tools:** none. It reasons over the evidence it is given; there is nothing to look up.
- **Finality:** a day resolved when it is 10 or more days old is final (`provisional = false`): its
  charges have posted and the phone has had time to upload. A younger day is provisional.

### Transaction location (pure, no AI)

`locate(tx, payee)` reads the resolved days for `tx.date - 9 .. tx.date` and picks a purchase day:

1. **One country in the window** (the usual case): that country. The location is that of
   `tx.date - 2`, or the nearest day that has one.
2. **Several countries, and the payee is `local` or `chain`** with a country that appears in the
   window: the nearest day on or before `tx.date` on which the owner was in the payee's country.
   IMPERIAL STORE, posted 2026-09-23 with the owner back in Guatemala, resolves to 2026-09-20 in
   Costa Rica.
3. **Otherwise:** `tx.date - 2`, the typical posting lag, falling back to the nearest resolved day.
4. **No resolved day with a country:** null.

The result is written to `bank_tx.country` / `bank_tx.location` and recorded as a `location` row.
It is `final` when every day it depended on is final; a non-final result is recomputed on a later
sweep.

### Payee location matcher (AI, WebSearch)

- **Runs when** a transaction has a payee whose `location_kind` is `NULL` — whichever tier matched
  it, and immediately after the AI payee matcher creates a payee.
- **Input:** the payee's name; up to ten sample descriptions with their dates; the distribution of
  place fields across its transactions; the location of the transaction that triggered it.
- **Output:** `kind`, `country`, `location`, `confidence`, `summary`.
- **Guidance it carries:**
  - `remote` for online and global businesses, with the head-office country (Amazon, Uber: `US`).
  - `chain` when the descriptions show several branches in one country (La Torre: `GT`).
  - `local` for a single place; for a small business with no web presence, the place fields and
    where the owner was are the evidence.
  - `unknown` rather than a guess when none of that settles it.
- **Writes** `payee` in Postgres behind the existing `ReplicaSettled` barrier, and a
  `payee_location_result` row.

### AI payee matcher — changes

- Its "location history" block is built from resolved days instead of raw tracker lines, so it no
  longer sees `assumed` filler at all.
- `search_payees` returns each candidate's `country`, `location` and `location_kind`.
- `create_payee` is unchanged: location is set by the payee location matcher, not self-reported.
- Step 3 of its prompt ("Country codes") keeps the one-payee-per-brand rule.

## Order of work per transaction

1. `ensureDays` for the transaction's ten-day window (may call the day resolver).
2. Payee matching as today: exact, rule, then the AI payee matcher with the resolved days.
3. `locate` the transaction and write its country and location.
4. If it has a payee with `location_kind IS NULL`, run the payee location matcher.

A transaction that already has a payee skips step 2. A transaction with a terminal `none` verdict
still gets steps 1 and 3.

The queue stays at `concurrency: 1`. Work arrives as today (`row-persisted` inserts, and the boot
sweep), with the sweep widened to select 2026 transactions that are unmapped, **or** have no final
`location` row, **or** whose payee has no `location_kind`.

Expected cost of the 2026 backfill: 20-25 day-resolver calls, about 180 payee-location calls, and no
AI for the 1,335 transaction lookups.

## Failure handling

- A failure in any location step never fails payee matching. The fields stay null, nothing terminal
  is written, and the next sweep retries.
- Dawarich unavailable: the day resolver still runs on card evidence alone; the days it writes are
  provisional regardless of age.
- An AI answer that fails validation (bad country code, missing date) is a failed run.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `TX_LOCATION_ENABLED` | `true` | existing switch; `false` disables every location step |
| `TX_LOCATION_MODEL` | value of `TX_AI_MODEL` | model for the two new agents |
| `TX_LOCATION_EFFORT` | `medium` | effort for the two new agents |

## Testing

Unit tests (`*.spec.ts`, `test(...)`), with every agent stubbed:

- `day-evidence`: which charges are included for a run; observed/assumed/missing labelling.
- `tx-location`: each of the four rules, including the Imperial Store case and an all-null window.
- `owner-location.service`: resolves only unresolved or stale-provisional days; batches runs of at
  most 14; rejects an answer that omits a date; finality by age.
- payee location trigger: runs for `NULL` kind only; runs after an AI-created payee; never for
  `unknown`.
- sweep selection: the three reasons a transaction is picked up, and that a final `location` row
  excludes it.
- prompt builders for both new agents.

Acceptance checks against real 2026 data, run once after the backfill:

| Days | Expected | Why it is a test |
| --- | --- | --- |
| 2026-01-08 .. 2026-01-28 | Guatemala | tracker says San José (assumed); card says Guatemala City |
| 2026-05-05 .. 2026-05-07 | Guatemala | same |
| 2026-09-11 .. 2026-09-19 | Costa Rica | live tracker, observed |
| IMPERIAL STORE, 2026-09-23 | transaction in `CR` | rule 2 |

## Out of scope

- Showing any of these fields in the web app.
- Transactions and payees before 2026-01-01.
- Splitting existing payees per country.
- Transfers (`transfer_bank_account_id`), unchanged.

## Implementation notes

What was built differs from the text above in these ways. Each was forced by something the design
missed.

- **The transaction lookup runs again once its payee's place is known.** The order of work puts the
  lookup (step 3) before the payee location matcher (step 4), so rule 2 could never fire the first
  time a payee is seen: IMPERIAL STORE would have been recorded in Guatemala, as a final answer.
  After step 4 finds a `local` or `chain` payee, every 2026 transaction of that payee is looked up
  again.
- **The sweep repeats every 24 hours**, not only at boot. The service runs for weeks, and a freshly
  scraped transaction is located from provisional days; only a later sweep can make it final.
- **The sweep resolves all the days it needs as its first job.** Transactions are queued in
  `created_at` order, which is not date order, so resolving days per transaction would have asked
  for fragments of ten days or fewer instead of 14-day runs.
- **A run is shown the answers already given for the days either side of it.** Without them the
  first dry run put 2026-01-29 in Costa Rica: that run began the day after three weeks of card use
  in Guatemala that it could not see, and read the tracker's stale position as a flight.
- **A terminal `none` verdict is checked in `process()` as well as in the sweep.** The widened sweep
  selects those transactions to locate them, and would otherwise have re-run the payee agent on
  all 88.
- **A `location` row is written only when the lookup says something new** (a different result, or
  the same one now final), and both of its writes go through the replica barrier.
- **Failures are remembered until the queue drains**, for a run of days and for a payee, so one
  failing agent call is not repeated by every transaction that needs it.
- **Place fields are filtered before the resolver sees them.** A third of the 5-character "city"
  fields in 2026 hold a phone number, a URL or punctuation; those are dropped. Brand fragments
  (`OPENA`, `ANTHR`) cannot be told apart by shape, so the prompts name them.
- **`remote` covers bills, however local the company.** The first backfill filed Tigo, Claro, an
  insurer and a gym under `chain`, as the guidance above says to. Rule 2 then read their automatic
  charges as in-person purchases and moved one that posted during a trip back to Guatemala. `chain`
  now means "several branches in one country, paid in person"; a phone company, a utility, an
  insurer, a bank or a membership is `remote` with the company's own country.
- **A payee's transactions are looked up again after any answer**, not only a `local` or `chain`
  one, so that re-asking a payee whose kind changes also moves its transactions.
- **A global chain is `chain` with no country, and a purchase is placed by its own description.**
  The data model above gives every `chain` a country. In the first backfill that filed Subway, H&M
  and Old Navy as Guatemalan chains because the owner's charges were, The North Face as Costa
  Rican, and McDonald's and Starbucks as `remote` with a US head office: one kind of brand, three
  answers. The owner's decision (2026-10-04): a brand with branches in many countries is `chain`
  with a null country. Rule 2 then cannot use the payee's country, so it reads the branch's country
  off the transaction's own description — a trailing country code directly, a city field through a
  new table, `place_field` (migration `0016`), which an agent fills once per distinct field. The
  description is tried before the payee's country (`rule: description-country`), and only for
  `local` and `chain` payees. `remote` may also go without a country when the company cannot be
  placed.
- **A travel day resolves to the country the owner left.** A day has one country; the departure
  side is where anything bought at the airport was bought.
- **`location/` lost its prompt formatting and last-known lookup.** The payee matcher no longer
  reads raw tracker lines, so `LocationService` now only answers "what did the tracker record on
  these days", all-or-nothing.
- **One shared agent runner** (`src/agent/structured-agent.ts`) replaced the payee matcher's private
  session loop, so all three agents set the same load-bearing options in one place.

## Open items

- **The two-day fallback.** Rule 3 assumes a purchase happened two days before it posted. It only
  decides anything for remote payees on the days around a trip. Measured lag in the clean 2026
  cases was 2-3 days.
- **Day resolver quality is unmeasured.** The acceptance table is the first check; if it misses,
  the prompt is the thing to change, not the lookup rules.
