import {
  and,
  asc,
  bankTx,
  category,
  categoryGroup,
  db,
  desc,
  eq,
  gte,
  isNull,
  lte,
  sql,
} from '@bank-bots/db';
import { monthRange } from '~/lib/filters';
import { mapTxRow, txRowQuery, type TxRow } from './tx-row';

/**
 * YNAB's bookkeeping group. It holds exactly two categories: `Inflow: Ready to Assign` (where all
 * income lands) and an unused `Uncategorized`. It is hidden from the category table because income
 * is reported by the header's Inflow figure instead — showing it as a group would put a positive
 * five-figure row in the middle of a spending breakdown.
 *
 * Matched by name because that is the only handle we have: these rows carry YNAB's own uuids, so
 * there is no stable local id to key off. The name is fixed by YNAB, not user-editable.
 */
const INTERNAL_GROUP_NAME = 'Internal Master Category';

/** The bucket behind a clickable figure — what the drill-down dialog lists. */
export type SpendingBucket =
  | { kind: 'category'; categoryId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'uncategorized' }
  | { kind: 'inflow' }
  | { kind: 'outflow' }
  | { kind: 'all' };

export type SpendingCategory = {
  id: string;
  name: string;
  /** Net for the month: inflow − outflow. Negative for ordinary spending. */
  netCents: number;
  txCount: number;
};

export type SpendingGroup = {
  id: string;
  name: string;
  netCents: number;
  categories: SpendingCategory[];
};

export type MonthSummary = {
  month: string;
  inflowCents: number;
  outflowCents: number;
  /** inflow − outflow. The "left over" figure. */
  netCents: number;
  groups: SpendingGroup[];
  /** Null when every transaction in the month has a category. */
  uncategorized: { netCents: number; txCount: number } | null;
};

/**
 * Transactions that count toward a month's spending.
 *
 * Transfers are excluded everywhere: moving money between the owner's own accounts is neither
 * income nor spending, and counting it inflates both sides of the ledger. No row carries
 * `transfer_bank_account_id` today, so this is currently a no-op — but the large uncategorized
 * amounts in this data ARE self-transfers, and marking them is the intended fix. Shipping the
 * filter now means that fix needs no code change.
 */
function monthConditions(month: string) {
  const range = monthRange(month);
  return [
    gte(bankTx.date, range.from),
    lte(bankTx.date, range.to),
    isNull(bankTx.transferBankAccountId),
  ];
}

// Split by sign rather than a plain sum, so one pass yields both the header's gross inflow/outflow
// and each category's net. Summing net per category could not reconstruct the gross figures —
// a refund inside a spending category would cancel against that category's spending.
const inflowSum = sql<string>`coalesce(sum(case when ${bankTx.amountCents} > 0 then ${bankTx.amountCents} else 0 end), 0)`;
const outflowSum = sql<string>`coalesce(sum(case when ${bankTx.amountCents} < 0 then -${bankTx.amountCents} else 0 end), 0)`;

/**
 * One month's spending, grouped category group → category.
 *
 * Deliberately a single grouped query rather than one for the header and one for the table: two
 * queries would have to keep identical filters to stay consistent, and would drift the first time
 * one of them changed.
 */
export async function monthSummaryQuery(input: { month: string }): Promise<MonthSummary> {
  const rows = await db
    .select({
      groupId: categoryGroup.id,
      groupName: categoryGroup.name,
      categoryId: category.id,
      categoryName: category.name,
      inflow: inflowSum,
      outflow: outflowSum,
      txCount: sql<string>`count(*)`,
    })
    .from(bankTx)
    .leftJoin(category, eq(bankTx.categoryId, category.id))
    .leftJoin(categoryGroup, eq(category.groupId, categoryGroup.id))
    .where(and(...monthConditions(input.month)))
    .groupBy(categoryGroup.id, categoryGroup.name, category.id, category.name);

  let inflowCents = 0;
  let outflowCents = 0;
  // Accumulated rather than assigned: `GROUP BY category.id` collapses every uncategorized
  // transaction into one row, but an orphan category (one whose group has been deleted) would
  // arrive as a second row that also belongs in this bucket.
  let uncategorizedNet = 0;
  let uncategorizedCount = 0;
  const groups = new Map<string, SpendingGroup>();

  for (const row of rows) {
    const inflow = Number(row.inflow);
    const outflow = Number(row.outflow);
    const net = inflow - outflow;

    // The header reports every transaction in the month, including income and uncategorized rows —
    // so it accumulates before any of the table's filtering below.
    inflowCents += inflow;
    outflowCents += outflow;

    if (!row.categoryId || !row.groupId) {
      uncategorizedNet += net;
      uncategorizedCount += Number(row.txCount);
      continue;
    }

    if (row.groupName === INTERNAL_GROUP_NAME) {
      continue;
    }

    const group = groups.get(row.groupId) ?? {
      id: row.groupId,
      name: row.groupName ?? '',
      netCents: 0,
      categories: [],
    };
    group.netCents += net;
    group.categories.push({
      id: row.categoryId,
      name: row.categoryName ?? '',
      netCents: net,
      txCount: Number(row.txCount),
    });
    groups.set(row.groupId, group);
  }

  // Biggest spender first, at both levels. `netCents` is negative for spending, so ascending order
  // puts the largest outflow on top — and a category that netted positive (a refund month) sorts
  // last, which is where it belongs in a spending breakdown.
  const sorted = [...groups.values()].sort((a, b) => a.netCents - b.netCents);
  for (const group of sorted) {
    group.categories.sort((a, b) => a.netCents - b.netCents);
  }

  return {
    month: input.month,
    inflowCents,
    outflowCents,
    netCents: inflowCents - outflowCents,
    groups: sorted,
    uncategorized: uncategorizedCount
      ? { netCents: uncategorizedNet, txCount: uncategorizedCount }
      : null,
  };
}

/**
 * The transactions behind one figure on the spending page.
 *
 * Unpaginated: a bucket is bounded by a single month, and the largest in this data is 37 rows
 * (January's `Variable → Miscellaneous`). The cap is a guard against a pathological month, not a
 * paging mechanism — if it is ever hit, this needs the register's keyset paging rather than a
 * bigger number.
 */
const BUCKET_LIMIT = 500;

export async function listBucketTransactionsQuery(input: {
  month: string;
  bucket: SpendingBucket;
}): Promise<TxRow[]> {
  const { bucket } = input;
  const conditions = [
    ...monthConditions(input.month),
    bucket.kind === 'category' && eq(bankTx.categoryId, bucket.categoryId),
    bucket.kind === 'group' && eq(category.groupId, bucket.groupId),
    bucket.kind === 'uncategorized' && isNull(bankTx.categoryId),
    bucket.kind === 'inflow' && gte(bankTx.amountCents, 1),
    bucket.kind === 'outflow' && lte(bankTx.amountCents, -1),
  ].filter((condition) => !!condition);

  const rows = await txRowQuery()
    .where(and(...conditions))
    .orderBy(desc(bankTx.date), asc(bankTx.id))
    .limit(BUCKET_LIMIT);

  return rows.map(mapTxRow);
}
