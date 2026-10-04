import { and, asc, eq, exists, isNull, notExists, or, sql } from 'drizzle-orm';
import { bankTx, matcherResult, payee } from '~/replica-db/replica-schema';
import type { ReplicaDb } from '~/replica-db/replica-db.service';
import type { TxLocation } from '~/owner-location/tx-location';

/** Has the AI tier already looked at this transaction and found no payee? Terminal: see start(). */
export function hasNoneVerdict(replica: ReplicaDb, txId: string): boolean {
  return (
    replica.db
      .select({ id: matcherResult.id })
      .from(matcherResult)
      .where(and(eq(matcherResult.bankTxId, txId), eq(matcherResult.type, 'none')))
      .limit(1)
      .get() !== undefined
  );
}

/** The most recent location lookup recorded for a transaction, if any. */
export function lastLocation(replica: ReplicaDb, txId: string): TxLocation | null {
  const row = replica.db
    .select({ data: matcherResult.data })
    .from(matcherResult)
    .where(and(eq(matcherResult.bankTxId, txId), eq(matcherResult.type, 'location')))
    // uuidv7 ids sort by creation time, so this is the latest lookup.
    .orderBy(sql`${matcherResult.id} DESC`)
    .limit(1)
    .get();
  return (row?.data as TxLocation | undefined) ?? null;
}

/**
 * The transactions a sweep has work for, oldest-created first.
 *
 * A transaction dated on or after `fromDate` is picked up for any of three reasons:
 *
 *   1. it has no payee, and the AI tier has not already given up on it;
 *   2. it has no FINAL location lookup — never looked up, or looked up from days that could still
 *      change;
 *   3. its payee has not had its own place looked up (`location_kind IS NULL`).
 *
 * Reasons 2 and 3 apply only when `withLocation` is set. Transfers and reconciliation rows are
 * never matched and never located.
 *
 * A 'none' verdict is terminal for reason 1 only: the AI tier already looked and found no payee.
 * Roughly one in eight unmapped rows is an inter-account transfer that can never have one, and
 * without the exclusion they would cost an agent call on every sweep. Re-ask by hand with:
 * DELETE FROM matcher_result WHERE bank_tx_id = '<uuid>' AND type = 'none';
 */
export function selectBacklog(
  replica: ReplicaDb,
  fromDate: string,
  withLocation: boolean,
): { id: string; date: string; description: string; payeeId: string | null }[] {
  const { db } = replica;
  const verdict = (type: string, extra = sql`1`) =>
    db
      .select({ one: sql`1` })
      .from(matcherResult)
      .where(and(eq(matcherResult.bankTxId, bankTx.id), eq(matcherResult.type, type), extra));

  const unmapped = and(isNull(bankTx.payeeId), notExists(verdict('none')));
  // `data` is the JSON text of the lookup; json_extract reads its boolean as 1.
  const notLocated = notExists(
    verdict('location', sql`json_extract(${matcherResult.data}, '$.final') = 1`),
  );
  const payeeNotPlaced = exists(
    db
      .select({ one: sql`1` })
      .from(payee)
      .where(and(eq(payee.id, bankTx.payeeId), isNull(payee.locationKind))),
  );

  return (
    db
      .select({
        id: bankTx.id,
        date: bankTx.date,
        description: bankTx.description,
        payeeId: bankTx.payeeId,
      })
      .from(bankTx)
      .where(
        and(
          isNull(bankTx.transferBankAccountId),
          eq(bankTx.reconcile, false),
          sql`${bankTx.date} >= ${fromDate}`,
          withLocation ? or(unmapped, notLocated, payeeNotPlaced) : unmapped,
        ),
      )
      // created_at ties are common (one per scrape run), so id breaks them for a stable order.
      .orderBy(asc(bankTx.createdAt), asc(bankTx.id))
      .all()
  );
}
