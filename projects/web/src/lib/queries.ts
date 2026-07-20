import { queryOptions } from '@tanstack/react-query';
import { listAccounts } from '~/server/accounts';
import { listCategories, listPayees } from '~/server/lookups';
import { listPayeeSummaries, unmatchedCount } from '~/server/payees';
import { listBucketTransactions, monthSummary } from '~/server/spending';
import type { SpendingBucket } from '~/server/queries/spending';

export function accountsQueryOptions() {
  return queryOptions({
    queryKey: ['accounts'],
    queryFn: () => listAccounts(),
  });
}

// Payees and categories change rarely (they're imported wholesale from YNAB and only grow when the
// AI matcher creates one), so a long staleTime keeps the row editor from refetching 685 rows every
// time a combobox opens.
const LOOKUP_STALE_TIME = 5 * 60 * 1000;

export function payeesQueryOptions() {
  return queryOptions({
    queryKey: ['payees'],
    queryFn: () => listPayees(),
    staleTime: LOOKUP_STALE_TIME,
  });
}

export function categoriesQueryOptions() {
  return queryOptions({
    queryKey: ['categories'],
    queryFn: () => listCategories(),
    staleTime: LOOKUP_STALE_TIME,
  });
}

export function payeeSummariesQueryOptions() {
  return queryOptions({
    queryKey: ['payee-summaries'],
    queryFn: () => listPayeeSummaries(),
  });
}

export function unmatchedCountQueryOptions() {
  return queryOptions({
    queryKey: ['unmatched-count'],
    queryFn: () => unmatchedCount(),
  });
}

export function monthSummaryQueryOptions(month: string) {
  return queryOptions({
    queryKey: ['month-summary', month],
    queryFn: () => monthSummary({ data: { month } }),
  });
}

/**
 * The transactions behind one figure on the spending page.
 *
 * `enabled` is the caller's business: the dialog mounts with no bucket selected, and this must not
 * fire until one is.
 */
export function bucketTransactionsQueryOptions(month: string, bucket: SpendingBucket | null) {
  return queryOptions({
    queryKey: ['bucket-transactions', month, bucket],
    queryFn: () => listBucketTransactions({ data: { month, bucket: bucket! } }),
    enabled: bucket !== null,
  });
}
