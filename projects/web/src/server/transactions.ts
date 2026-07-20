import { createServerFn } from '@tanstack/react-start';
import type { TxFilters } from '~/lib/filters';
import { listTransactionsQuery } from './queries/transactions';

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
