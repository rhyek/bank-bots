import { queryOptions } from '@tanstack/react-query';
import { listAccounts } from '~/server/accounts';

export function accountsQueryOptions() {
  return queryOptions({
    queryKey: ['accounts'],
    queryFn: () => listAccounts(),
  });
}
