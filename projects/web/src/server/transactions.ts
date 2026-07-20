import { createServerFn } from '@tanstack/react-start';
import type { TxFilters } from '~/lib/filters';
import { listTransactionsQuery, updateTransactionQuery } from './queries/transactions';

export const listTransactions = createServerFn()
  .inputValidator(
    (input: { filters: TxFilters; cursor: string | null; pageSize?: number }) => input,
  )
  .handler(({ data }) =>
    listTransactionsQuery({
      filters: data.filters,
      cursor: data.cursor,
      // Cap the page size so a hand-crafted request can't ask for the whole table in one response.
      pageSize: Math.min(data.pageSize ?? 100, 500),
    }),
  );

/**
 * Writes payee / category / memo. Only fields present on the input are written, so passing
 * `payeeId: null` clears it while omitting it leaves the column alone — see updateTransactionQuery
 * for why the writable set is exactly these three.
 */
export const updateTransaction = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: {
      id: string;
      payeeId?: string | null;
      categoryId?: string | null;
      memo?: string | null;
    }) => input,
  )
  .handler(({ data }) => updateTransactionQuery(data));
