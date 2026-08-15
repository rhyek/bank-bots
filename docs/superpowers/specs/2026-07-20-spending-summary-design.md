# Spending summary — design

A per-month view of where the money went, modelled on YNAB's Plan page but **read-only**: no
budgeting, no assigning, no buckets to fund. Category group → category → the transactions behind a
number → that transaction highlighted in the transactions list.

## Why

The transactions list answers "what did I spend on July 3rd". It cannot answer "how much did I spend on
restaurants in May, and did I save anything". This page does, from the same `bank_tx` rows — no new
schema, no migration.

## The header

Three figures, over every transaction in the month, all accounts:

| | |
| --- | --- |
| **Inflow** | sum of positive `amount_cents` |
| **Outflow** | sum of negative `amount_cents`, shown positive |
| **Left over** | `inflow − outflow` |

Verified against January 2026: `+$11,183.14 / −$6,556.96 / +$4,626.18`.

**Why net, not `starting balance − spending`.** The owner's YNAB budget tracked leftover money in a
`Savings` category, which shows **$4,623.04 assigned in January**. Net for January is **$4,626.18** —
a $3.14 difference. The number that budget was really tracking is net for the month, and net is the
figure that stays comparable month to month; a running balance is dominated by accumulated savings
and buries the month's own signal.

## What counts

**Transfers are excluded** — every query filters `transfer_bank_account_id IS NULL`. A transfer
between the owner's own accounts is not income and not spending; counting it inflates both sides.

This matters more than the current data suggests. **Today zero rows have that column set**, so the
filter is a no-op — but the uncategorized transactions are overwhelmingly self-transfers
(`BACSJO BCO −10,000.00` paired with `DEPOSITO AHORRO +10,000.00`, plus recurring
`TF:ACH PERSONAS −2,500.00`). May 2026 carries $15,575.16 uncategorized outflow against $10,000.00
uncategorized inflow; June 2026 carries $19,560.01.

**Uncategorized transactions are included in the totals** (owner's explicit choice, over excluding
them or listing them outside the math). Every dollar is therefore accounted for, at the cost of a
leftover figure that swings hard in months with large self-transfers — May 2026 will read roughly
−$8k. Marking those rows with `transfer_bank_account_id` fixes the number with no code change,
because the filter is already there. That is the intended path, and it is why the filter ships now
rather than later.

**Reconcile rows are included.** A manual reconciliation row is a real balance movement (one exists
today).

## The table

Category group → category, groups expanded by default, each row showing **net activity** for the
month (spending minus refunds). A `Quality of Life → Vegas 2025 +$100.00` refund therefore reduces
that category rather than inflating Inflow — matching how YNAB's Activity column behaves.

- **Groups sort by spend descending**, categories within a group likewise. This answers "where did
  my money go" on sight. The cost is that rows reshuffle as you page between months.
- **Categories with no activity in the month are omitted.** This is a report, not a budget: an empty
  row has nothing to say.
- **`Internal Master Category` is hidden.** It holds exactly two categories — `Inflow: Ready to
  Assign` (150 transactions, the owner's income) and `Uncategorized` (0 transactions) — and is
  YNAB's bookkeeping group, not a spending category. Its income is the header's Inflow line instead.
  Identified by group name, in a named constant; the group name is fixed by YNAB.
- **An `Uncategorized` row** sits last with its transaction count, and feeds the totals.

## Drill-down

Clicking any activity amount — a category, a group, `Uncategorized`, or a header figure — opens a
**dialog** listing that bucket's transactions (account, date, payee, description, amount). A dialog
rather than a popover because a single bucket gets large: `Variable → Miscellaneous` alone had 37
transactions in January.

Buckets: `category` (one category), `uncategorized`, `inflow` (positive amounts), `outflow`
(negative amounts), `all` (the Left over row).

## Jumping to a transaction

Clicking a row in that dialog navigates to:

```
/accounts?window=custom&from=<month start>&to=<month end>&highlight=<txId>
```

The transactions list reads `highlight`, fetches pages until that row is loaded, scrolls it into view, and
rings it.

**Why this over the alternatives.** Filtering the transactions list to the category instead would need no
seek logic, but loses seeing the transaction among its neighbours — which is the point. Having the
server return the row's rank so the client can jump straight to it is more precise, but needs a
window-function count and a new query shape to save one page fetch on a ~100–200 row month.

`highlight` is deliberately **not** part of `TxFilters`. `TxFilters` is the React Query key, so
folding a view concern into it would refetch the whole list every time the highlight changed. The
route parses it alongside the filters and passes it to `<Transactions>` as its own prop.

Seeking is bounded twice: by `hasNextPage` (it stops at the end of the filtered set) and by a
row cap, so a `highlight` pointing at a transaction outside the current window — a hand-edited URL,
or a filter changed after arriving — cannot walk the entire table.

## Structure

**New**

| File | Responsibility |
| --- | --- |
| `server/queries/tx-row.ts` | The joined `TxRow` select, joins and row mapping, extracted from `transactions.ts` so both the transactions list and the drill-down produce identical rows |
| `server/queries/spending.ts` | `monthSummaryQuery`, `listBucketTransactionsQuery` |
| `server/spending.ts` | The two server fns |
| `routes/_app/spending.tsx` | Route + page |
| `components/spending/month-nav.tsx` | `‹ July 2026 ›` + Today |
| `components/spending/summary-header.tsx` | The three figures |
| `components/spending/category-table.tsx` | Groups + categories + Uncategorized |
| `components/spending/activity-dialog.tsx` | The drill-down |

**Modified:** `server/queries/transactions.ts` (use the extracted row helpers), `components/transactions/transactions.tsx`
(seek + scroll), `components/transactions/transaction-row.tsx` (highlight styling), `lib/filters.ts`
(`highlight` param + month helpers), `components/app-sidebar.tsx` (nav item), `lib/queries.ts` (query options).

`monthSummaryQuery` is a **single** grouped query that returns inflow and outflow per category. The
header sums every row; the table filters the internal group out. Two separate queries would have to
agree on the same filters to stay consistent, and would drift the first time one changed.

## Testing

Against the real database, on months whose answers are known:

- January 2026 totals are exactly `1118314 / 655696 / 462618` cents, and its six visible groups
  carry the expected totals — verified by hand against the raw table.
- Group totals do **not** sum to outflow, and the tests assert that they don't. January's
  `Quality of Life` nets **+$100.00** from the Vegas 2025 refund: that $100 is in the header's gross
  inflow *and* nets against its own category, so the two sides differ by exactly the refunds. This
  is the "net, not gross" rule, and it is asserted rather than worked around.
- Every group's aggregate total equals the sum of the rows its drill-down returns. The summary and
  the drill-down are separate queries over the same filters; this is the check that they can't drift.
- The internal group never appears among the table's groups, and its income is in the header.
- A month with uncategorized transactions (May 2026) produces an `Uncategorized` bucket whose
  amount is included in the totals.
- Transfer exclusion is asserted through the query's filters rather than the data, since no row
  carries `transfer_bank_account_id` today.
- Month arithmetic (`monthRange`, previous/next across a year boundary) is unit-tested with an
  injected clock, like `resolveWindow`.

## Not doing

Budgeting or assigning money. Editing from this page. Year-over-year or multi-month comparison.
Charts. Per-account scoping — this page is always all-accounts, like YNAB's Plan.
