import { bankTx, count, db, desc, eq, isNull, payee, sql } from '@bank-bots/db';

export type PayeeSummary = {
  id: string;
  name: string;
  txCount: number;
  totalCents: number;
  lastDate: string | null;
};

/**
 * Every payee with how much has gone through it. Left-joined, so payees the AI matcher created but
 * never actually assigned still appear (with a zero count) rather than silently vanishing.
 */
export async function listPayeeSummariesQuery(): Promise<PayeeSummary[]> {
  const rows = await db
    .select({
      id: payee.id,
      name: payee.name,
      // count(bankTx.id) rather than count(*): on a left join with no match, count(*) would be 1.
      txCount: count(bankTx.id),
      totalCents: sql<string>`coalesce(sum(${bankTx.amountCents}), 0)::bigint`,
      lastDate: sql<string | null>`max(${bankTx.date})`,
    })
    .from(payee)
    .leftJoin(bankTx, eq(bankTx.payeeId, payee.id))
    .groupBy(payee.id)
    .orderBy(desc(count(bankTx.id)));

  return rows.map((row) => ({ ...row, totalCents: Number(row.totalCents) }));
}

/** Drives the badge on the sidebar's Unmatched item. */
export async function unmatchedCountQuery(): Promise<number> {
  const [row] = await db.select({ total: count() }).from(bankTx).where(isNull(bankTx.payeeId));
  return row?.total ?? 0;
}
