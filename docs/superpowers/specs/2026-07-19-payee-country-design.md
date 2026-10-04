# payee.country — country of the paying entity

**Date:** 2026-07-19
**Status:** superseded on 2026-10-04 by `2026-10-04-owner-and-payee-location-design.md`; never implemented
**Depends on:** `2026-07-19-tx-ai-matcher-design.md` (the AI tier writes this column)

## Goal

Record which country each payee's **entity** is in, as an ISO 3166-1 alpha-2 code, and have the
matcher determine it as part of resolving a transaction.

## The rule, and why it is not "where I was"

`country` describes the **legal/billing entity being paid**, not the owner's physical location when
the charge happened. The two diverge constantly, and picking the wrong one makes the column
meaningless.

The decisive case is Uber. All three of these are on the same Guatemalan card, in overlapping date
ranges:

```
UBER *TRIP  NL     n=92   2022-02 .. 2023-10     Uber B.V., Amsterdam
UBER*RIDES  GT     n=64   2023-03 .. 2024-02     Uber Guatemala
UBER *TRIP  CR     n=7    2023-08 .. 2023-12     Uber Costa Rica
```

The 92 `NL` rides physically happened in Guatemala. Under "where I was" they would all be `GT` and
the distinction would vanish. Under **"where the entity is"** they are `NL` — Uber B.V. is a Dutch
company — and the trailing country field becomes *authoritative* rather than misleading.

This reverses an earlier reading in the tx-ai-matcher spec, which treated the trailing field as a
"payment rail, not a place" and therefore as noise. It is a payment rail — and the rail **is** the
entity, which is exactly what this column records.

**Consequence: payees become country-scoped.** One payee, one country. `Uber` splits into `Uber NL`,
`Uber GT`, `Uber CR`. A Costa Rican transaction must resolve to the CR payee, never the GT one.

## Schema

```ts
// projects/db/src/schema.ts — payee
country: text(),  // ISO 3166-1 alpha-2, nullable
```

Nullable on purpose: `NULL` means *not yet determined*, which is honest and is the input to the
deferred resolution below. It never means "no country".

`payee` is already replicated, so the replica schema and `EXPECTED_SCHEMA_VERSION` bump alongside it.

## Signal analysis (measured 2026-07-19)

Across 539 payees that have transactions:

| Signal | Payees | Treatment |
| --- | --- | --- |
| One consistent country code | 330 | assign directly |
| Several country codes | 6 | **split into per-country payees** |
| No signal at all | 195 | research or defer (below) |

### The whitelist is derived, not guessed

A trailing two-letter token is only a country when it is one. Truncated merchant names end in valid
ISO codes constantly, so ISO membership alone does not filter them — frequency plus inspection does:

| Code | Evidence | Verdict |
| --- | --- | --- |
| `GT` | 2139 txs / 224 payees | real |
| `US` | 539 / 40 | real |
| `NL` | 129 / 3 — Uber, Uber Eats, Shottr | real |
| `ES` | 107 / 1 — McDonald's (Spain) | real |
| `CR` | 49 / 18 | real |
| `SE` | 34 / 1 — Spotify (Spotify AB) | real |
| `IE` | 9 / 1 — Oculus (Meta bills from Ireland) | real |
| `AN` | 12 / 5 — `Café La Escalonia Antigua`, `tienda`, `café condesa` | **word ending** |
| `BA` | 9 / 1 — `Gaby` | **word ending** |
| `MO` | 19 / 1 — `ivannia` | **word ending** |
| `AI` `BI` `VN` `TV` `AL` `SC` `SJ` `GO` `CY` | 1–6 txs each | **word endings** |
| `UK` | 3 txs | **not ISO** (`GB` is) — word ending |

Low-volume plausible codes (`GB`, `MX`, `PA`, `CO`, `LU`, `CH`, `SV`, `DE`, `BE`, `CZ`) are checked
individually rather than accepted or rejected wholesale.

### The 6 payees that need splitting

`Uber`, `Uber Eats`, `McDonald's`, `Volaris`, `Siman`, `No sé`. Each becomes one payee per country,
named `<Name> <CC>`, matching the existing convention (`Boni Gourmet CR`, `La Estancia GT`). Their
transactions are re-pointed by the country code on each row.

The other 8 flagged as multi-country were false positives from the word-ending problem above.

## Backfill, in order of confidence

1. **Trailing country code**, whitelist-validated. Covers most of the 330.
2. **City field → country.** `GUATE`/`LA AN` → `GT`, `SAN J` → `CR`, `CIUDA` → `MX`. Used where there
   is no trailing code (30-char descriptions carry a city instead).
3. **Payee name suffix.** 34 payees already encode it (`Floristería Marvin CR`).
4. **Web search for the entity's head office** — the agent, for recognizable international brands:
   Netflix → `US`, Cloudflare → `US`, Namecheap → `US`, Anthropic → `US`. This is the same research
   it already does when identifying an unknown merchant, so it reuses the existing `WebSearch` tool.
5. **Defer.** Anything left is a small local business with no web presence and no country field —
   exactly the case where the entity's country is unknowable from the transaction alone. These stay
   `NULL`.

Steps 1–3 are deterministic and run as a one-shot script. Step 4 is an agent pass scoped to payees
whose names look like recognizable brands, so it is tens of calls rather than 195.

## Deferred resolution via the location API

The owner is building an API that reports **where they were at a given time**. That is the missing
evidence for the step-5 remainder: a small shop with no online footprint is, in practice, in the
country the owner was in when the charge cleared.

Design for it now, build against it later:

- Backfill leaves those payees `NULL` rather than guessing.
- When the API exists, a follow-up pass reads each `NULL` payee's earliest transaction date, asks the
  API where the owner was, and assigns that country.
- The AI tier gains the same fallback: when it cannot determine a new payee's country from the
  description or the web, it consults the location API for the transaction's date before giving up.

Until then `NULL` is the correct, honest value — and because it is nullable, nothing downstream has
to wait for this.

## Matching changes

Country is a property the matcher **determines**, not a new key it matches on:

- The exact and rule tiers copy the payee as before; country rides along with the payee, unchanged.
- The AI tier sets `country` whenever it creates a payee, and must pick the **country-correct** payee
  when one already exists — a Costa Rican charge resolves to `Uber CR`, not `Uber GT`.
- `create_payee` gains a required `country` argument (nullable, but the agent must decide rather than
  omit it).

### Prompt changes

The §3 "Country codes" section is rewritten. Its current framing — *trailing country is routing noise,
ignore it* — is now wrong. The replacement:

- The trailing field names the **entity** that billed, and that is what `country` records.
- Uber `NL` is Uber B.V. Amsterdam: a real Dutch entity, so `Uber NL` with country `NL`.
- A country inside the merchant name (`CLARO MCE MPC CR`) still means a separate national entity.
- Both now lead to the same action — a country-scoped payee — so the two cases stop being in tension.
- When no country appears anywhere, search for the entity's head office. If that fails, leave country
  unset rather than guessing.

The worked Uber/Claro example in the prompt is updated: it currently concludes "ONE payee: Uber",
which contradicts this design.

## Out of scope

- `bank_tx.country`. Considered and rejected: the country belongs to the entity, and duplicating it
  per row would drift the moment a payee is corrected.
- Back-populating country onto historical `matcher_result.data`.
- Any change to how exact/rule matching selects a source row.

## Open items

- Splitting a payee re-points historical transactions, which changes past budget reports grouped by
  payee. Worth a look before running it.
- `No sé` ("I don't know") splitting into `No sé CR` / `No sé GT` is technically correct and probably
  useless — likely better merged or left alone.

## Sequencing note

There is a large uncommitted changeset in the working tree from the tx-ai-matcher work. This design
touches the same files (`schema.ts`, the prompt, `create_payee`). Recommend reviewing and committing
that first so this lands as a separate, reviewable change.
