import { queryOptions } from '@tanstack/react-query';
import { listAccounts } from '~/server/accounts';
import { listCategories, listPayees } from '~/server/lookups';
import { listPayeeSummaries, unmatchedCount } from '~/server/payees';

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
