import type { bankTx } from '@bank-bots/db';

type ScrapedTx = typeof bankTx.$inferInsert;

/**
 * A bank can list two transactions identical on account, date, doc no, description and amount
 * (BAC's doc numbers are generic — e.g. two same-day delivery tips). `occurrence` tells them
 * apart: 1 for the first such row on the statement, 2 for the next, and so on. It is part of
 * `bank_tx_unique_cols`, so each copy is stored and re-scrapes land on the same rows.
 *
 * Call it with everything scraped for an account in statement order, before computing deletes.
 */
export function numberOccurrences(txs: ScrapedTx[]): ScrapedTx[] {
  const seen = new Map<string, number>();
  return txs.map((tx) => {
    const key = JSON.stringify([
      tx.bankAccountId,
      tx.date,
      tx.docNo,
      tx.description,
      tx.amountCents,
    ]);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { ...tx, occurrence };
  });
}
