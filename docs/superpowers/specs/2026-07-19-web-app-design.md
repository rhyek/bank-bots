# `@bank-bots/web` — transaction browser

Date: 2026-07-19

A TanStack Start app for reading (and lightly correcting) the transactions the scraper collects.
It replaces the part of YNAB the owner actually looks at: a list of transactions with their
payee and category, filtered by account and time window. It is the first consumer of the
payee/category data that `tx-payees` produces, and the first UI in this repo.

## Goals

- See every `bank_tx` row with its payee, category, and account, newest first.
- Filter by account (sidebar) and by time window (YNAB's View Options presets + an explicit range).
- Correct a wrong payee or category inline.
- Give each `bank_account` a human name, stored in the database.

## Non-goals (v1)

These are deliberately excluded. Each is a coherent follow-up, not an oversight.

- **Setting transfers.** An existing `transfer_bank_account_id` is *displayed* ("Transfer: BAC GT"),
  but nothing in the UI writes it. YNAB puts "To/From ⟨account⟩" entries in the payee dropdown; that
  is a v1.1 feature.
- **Manage Payees.** Renaming/merging across the 685 payees is its own screen.
- **Manual transactions.** No creating or deleting `reconcile` rows.
- **Editing date, account, description, or amount.** See "The immutability constraint" below.
- **Auth.** Single-user, local. No login, no user menu, no email anywhere in the chrome.

## The immutability constraint

This shapes the whole edit surface, so it is stated once, here.

`bank_tx` has a unique index `bank_tx_unique_cols` on
`(bank_account_id, date, doc_no, description, amount_cents)`. The scraper uses it as its upsert
conflict target, and its delete pass (`projects/scrape-txs/src/lib/bac/scrape.ts:277`) reconciles a
scraped month by comparing that same five-column natural key in JS and deleting any DB row it no
longer sees on the bank site.

So editing any of those five columns from the UI would, on the next scrape of that month, re-insert
the original row as a duplicate *and* delete the edited one. The single existing escape hatch is
`if (currentTx.reconcile) return false`.

**Therefore v1 writes only columns outside that key:** `payee_id`, `category_id`, and the new
`memo`. Account and date render read-only in the row editor. This requires **no change to
`scrape-txs`**, which is the stable core of the repo.

(Making `date` editable was considered and dropped. It would need either a `user_date` override
column plus a generated `effective_date` for the keyset index, or a `user_edited` flag that the
scraper's delete pass and upsert both honor. Both are viable; neither is worth it yet.)

## Schema changes

All additive; one migration in `@bank-bots/db`.

| Change | Rationale |
| --- | --- |
| `bank_account.name text` (nullable) | The rename target. UI falls back to `bank_key` + `account_number` when null. |
| `index bank_tx_date_id_idx on bank_tx (date, id)` | **Required.** `bank_tx` has only `bank_tx_pkey` and `bank_tx_unique_cols` today; the latter leads with `bank_account_id` and cannot serve `ORDER BY date DESC, id DESC`. Plain ASC suffices — Postgres reads it backward and keeps the index seek. |
| `bank_tx.memo text` (nullable) | Lets the owner annotate a transaction without touching `description`, which is part of the natural key. |

## Architecture

### Placement

`projects/web`, package `@bank-bots/web`. Registered in `pnpm-workspace.yaml` and
`devtooie.config.ts` on port **3002** (`tx-payees` holds 3001).

Follows the `prepare-tanstack-start-app` conventions: srvx production server (no Nitro), `~/` src
alias, Tailwind v4, custom client entry with StrictMode off, the same-origin CSRF middleware on
server functions, and the global sonner toast for mutation failures.

**One deliberate deviation from that skill: no instrumentation.** It offers OpenTelemetry or
Datadog, both of which assume a collector to export to. This app is single-user and runs on the
owner's machine alongside `tx-payees`; there is no collector and no operator to page. The
`Dockerfile` is kept (it costs nothing and matches the other packages), but its `CMD` is a plain
`node server.ts` with no `--import` tracer. Add one if this is ever deployed somewhere real.

Dev runs through devtooie (`pnpm devtooie`), which injects the workspace `.env.local` — including
`DATABASE_URL` — into the package's process. The `dev` script is `vite dev`, so it hot-reloads.

It consumes `@bank-bots/db` as TypeScript source over the workspace link (Vite transpiles it). That
package remains the sole owner of `drizzle-orm` — importing `drizzle-orm` directly from the app
would create a second physical instance under pnpm whose `SQL` types are mutually unassignable.

### Rendering strategy

SSR renders **layout and skeletons only**. No route loader fetches transaction data. Every query is
client-side through TanStack Query, so the first paint is the sidebar plus a skeleton table and the
data streams in after hydration.

The one thing that *is* read on the server is the cookie-backed chrome state (theme, sidebar
collapsed, layout variant), passed down from the root route as props — see "Template port" for why.

### Data access

Server functions, grouped by subject:

- `~/server/transactions.ts` — `listTransactions` (keyset page), `updateTransactionPayee`,
  `updateTransactionCategory`, `updateTransactionMemo`
- `~/server/accounts.ts` — `listAccounts` (with balances), `renameAccount`
- `~/server/payees.ts` — `listPayees`, `listCategories` (grouped)

### Keyset pagination

Ordered `date DESC, id DESC`, paginated by a `{ date, id }` cursor expressed as a **row-value tuple**:

```ts
.where(cursor
  ? sql`(${bankTx.date}, ${bankTx.id}) < (${cursor.date}::date, ${cursor.id}::uuid)`
  : undefined)
.orderBy(desc(bankTx.date), desc(bankTx.id))
.limit(pageSize)
```

Drizzle has no first-party cursor helper. Its
[official guide](https://orm.drizzle.team/docs/guides/cursor-based-pagination) recommends the
`or(lt(date), and(eq(date), lt(id)))` form instead — **do not use it.** Measured against this
database with a `(date, id)` index present:

- Row-value form → `Index Cond: (ROW(date, id) < ROW(...))`, a true seek. 20 rows scanned for 20 returned.
- OR form → `Filter: ((date < ...) OR ((date = ...) AND (id < ...)))`, `Rows Removed by Filter: 1116`
  at a moderate cursor depth, growing linearly with scroll depth.

The OR form silently reintroduces the `OFFSET` cost that keyset pagination exists to remove.

The `sql` fragment builder lives in `projects/db/src` (a `keysetBefore(cursor)` helper), not in the
app, for the drizzle-instance reason above.

Client side: `useInfiniteQuery` with `initialPageParam: null`, `getNextPageParam` returning
`undefined` (not `null` — `null` is a valid page param and would leave `hasNextPage` true) when a
short page comes back. Rows are flattened across pages and rendered through TanStack Virtual, which
needs a fixed row height.

The cursor crosses the wire as an opaque base64 JSON string, so the sort key can change later
without breaking client-held cursors.

## Template port

Source: [`satnaing/shadcn-admin`](https://github.com/satnaing/shadcn-admin) (12.7k★, MIT). It is a
Vite **SPA** on TanStack Router — React 19, Tailwind v4, shadcn `new-york`/slate, `@tanstack/react-table`.
There is no upstream TanStack Start version, so this is a subset vendor, not a fork.

**Taken:** `components/ui/*` (39 stock shadcn files, incl. `sidebar.tsx`), `components/layout/`
(`app-sidebar`, `nav-group`, `header`, `main`), `context/` (`theme-provider`, `layout-provider`),
`hooks/use-mobile.tsx`, `lib/{utils,cookies}.ts`.

**Not taken, though initially planned:** `components/data-table/*` and `hooks/use-table-url-state.ts`.
Both exist to map TanStack Table's client-side pagination/filter state to URL params. This list
paginates and filters *server-side* and renders through a virtualizer, so a `<tr>`-based table row
model buys nothing — the list is built directly on shadcn `Table` primitives with a CSS-grid row
layout (virtualized rows can't participate in native table layout). Filter state is held in
TanStack Router `validateSearch` schemas read via `useSearch`/`useNavigate`. `@tanstack/react-table`
is therefore not a dependency.

**Dropped:** Clerk and all of `routes/clerk/**`, `features/auth/**`, `routes/(auth)/**`,
`stores/auth-store.ts`, `sign-out-dialog.tsx`, `profile-dropdown.tsx` (and its 7 call sites),
`nav-user.tsx`, `team-switcher.tsx`, every `features/*` demo page. Runtime deps `@clerk/react`,
`zustand`, `axios`, `input-otp`, `@faker-js/faker` are not installed.

**Aliases:** the template's ~460 `@/` imports are codemodded to `~/` across the vendored subset, and
`components.json` aliases point at `~/` so future `shadcn add` output matches. Per the skill,
`components/ui/**` is added to the ESLint `globalIgnores` and is never hand-edited — behavior changes
go in a wrapper under `components/ui-kit/`.

### Two mandatory SSR fixes

The template was written for a client-only entry, so two things break under SSR:

1. **`context/theme-provider.tsx`** calls `window.matchMedia(...)` unguarded during render whenever
   `theme === 'system'` — which is the default. This is a hard server crash. Guard it with
   `typeof window === 'undefined'` and resolve the initial theme server-side.
2. **Cookie-seeded state → hydration mismatch.** `theme-provider` (`vite-ui-theme`),
   `layout-provider` (`layout_collapsible`, `layout_variant`), and the layout's
   `SidebarProvider defaultOpen` (`sidebar_state`) all seed `useState` from `getCookie(...)` in a
   lazy initializer, which returns `undefined` on the server and falls back to the default. Read
   these with `getCookie` from `@tanstack/react-start/server` in the root route and pass them as
   props, otherwise a dark theme or a collapsed sidebar flashes on every load.

Helpfully, the template uses **no** `localStorage` or `sessionStorage` anywhere — it migrated to
cookies, all guarded with `typeof document === 'undefined'` — and `use-mobile.tsx` already uses
`useSyncExternalStore` with a server snapshot. Those are the only two fixes needed.

## Screens

Routes under a single layout route that renders the sidebar.

| Route | Content |
| --- | --- |
| `/` | Overview: balance cards per account, total, unmatched count. The smallest screen; trimmable. |
| `/accounts` | All Accounts transactions list. |
| `/accounts/$accountId` | One account's transactions, plus rename. |
| `/unmatched` | Same list, `payee_id is null` (696 rows today). |
| `/payees` | 685 payees with transaction counts; click through to that payee's transactions. |

### Sidebar

```
📊 Overview
⚠️  Unmatched      696
🏷️  Payees
── ACCOUNTS ──────────────
🏦 All Accounts   $71,365
BAC GT
  • BAC GT        $35,674
BAC CR
  • Personal       $5,069
  • Mamá          $24,769
BANCO INDUSTRIAL
  • Monetaria      $5,851
```

Accounts group by `bank_key`; the label per account is `bank_account.name` falling back to the
account number. Right-click (or a `⋯` menu) opens the rename dialog.

**Balances are `SUM(amount_cents)`.** This is verified correct, not assumed: it equals the scraped
`running_balance_cents` exactly on both accounts that carry one, and matches the owner's YNAB
figures to the cent (BI Monetaria $5,851.57, BAC CR Mamá $24,769.16, BAC CR Personal $5,069.76).
Full history is scraped, so summing is sound.

No user button, no avatar, no email in the sidebar footer — the app is single-user.

### Transactions table

Columns, mirroring YNAB: **Account · Date · Payee · Category · Memo · Outflow · Inflow**.

- Memo shows `bank_tx.memo` when set, otherwise `description`.
- Outflow/Inflow split a signed `amount_cents`; negative → Outflow, positive → Inflow.
- A null `category_id` renders the yellow "This needs a category" pill.
- A row with `transfer_bank_account_id` renders "Transfer: ⟨account name⟩" in the payee cell, read-only.
- `reconcile` rows carry a small marker so manual rows are distinguishable.

**Row editing.** Double-click a row to enter edit mode for the whole row (YNAB's model, not
per-cell popovers). In edit mode:

- Account, Date, Outflow, Inflow render **read-only** (greyed) — see "The immutability constraint".
- Payee is a searchable `cmdk` combobox over the 685 payees.
- Category is a searchable combobox grouped by `category_group`, hidden groups excluded.
- Memo is a text input.
- Enter or a Save action commits; Escape cancels.

Each committed field is one server-fn mutation with an optimistic update on the infinite-query
cache, rolled back on failure. Failures surface through the global sonner toast wired in
`src/start.ts` — no per-call-site error banners.

### Filters

Matching YNAB's View Options: presets **This Month · Latest 3 Months · This Year · Last Year ·
All Dates**, plus an explicit From/To month+year range. Default is This Month.

Plus a free-text search over description and payee name.

All filter state lives in URL search params, validated by each route's `validateSearch` schema, so
any view is linkable and survives reload. The filter values are part of the React Query key, so
changing one resets the infinite query to its first page automatically.

## Error handling

Per the skill's built-in surface: mutation (POST) failures toast via sonner from the global function
middleware in `src/start.ts`; read and render errors hit the root `errorComponent`. After wiring,
propagation is confirmed by temporarily throwing inside a mutation handler and observing the toast.

Empty states are distinct from error states: an account with no transactions in the selected window
shows "No transactions in this period", not a spinner or an error.

## Testing

- **`@bank-bots/db`**: unit-test the `keysetBefore` helper's generated SQL via `.toSQL()` —
  it must emit a row-value comparison with bound parameters, not an OR chain.
- **Server functions**: test `listTransactions` filter and cursor behavior against the real
  database, read-only. Assert that paging the full set with a small page size yields every row
  exactly once, in `date DESC, id DESC` order, with no duplicates or gaps at page boundaries.
- **Mutations**: test `renameAccount` and the payee/category updates inside a rolled-back
  transaction so the real database is untouched.
- **Verification**: `pnpm -C projects/web build` must succeed (it proves the `~/` alias resolves,
  the client entry is picked up, and the srvx bundle emits), plus a manual pass with the app running
  against the live database.

## Open follow-ups

Recorded so they are not rediscovered later: setting transfers from the payee dropdown; a Manage
Payees screen; creating manual `reconcile` rows; making `date` editable via a `user_date` override
column; surfacing `matcher_result` (which tier assigned a payee, and the AI tier's summary) in the
transactions list.
