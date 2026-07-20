import { sql, type SQL } from 'drizzle-orm';
import { bankTx } from './schema';

/** A cursor into the `bank_tx` register, which is always ordered `date DESC, id DESC`. */
export type TxCursor = { date: string; id: string };

/**
 * Keyset predicate selecting the page AFTER `cursor`, for a query ordered `date DESC, id DESC`.
 *
 * Emitted as a row-value comparison — `(date, id) < ($1, $2)` — deliberately NOT the
 * `or(lt(date), and(eq(date), lt(id)))` form that Drizzle's cursor-pagination guide recommends.
 * Postgres compiles the row-value form to an `Index Cond`: a true seek on `bank_tx_date_id_idx`.
 * It cannot do the same for the OR-of-AND form, which degrades to a `Filter` that scans from the
 * top of the index and discards every row before the cursor — reintroducing exactly the O(offset)
 * cost that keyset pagination exists to remove, and growing linearly with scroll depth.
 *
 * The `::date` / `::uuid` casts are not strictly required (Postgres infers both correctly) but
 * pin the parameter types so an inference change can never silently alter the comparison.
 */
export function keysetBefore(cursor: TxCursor | null | undefined): SQL | undefined {
  if (!cursor) {
    return undefined;
  }
  return sql`(${bankTx.date}, ${bankTx.id}) < (${cursor.date}::date, ${cursor.id}::uuid)`;
}
