import { createServerFn } from '@tanstack/react-start';
import { listAccountsQuery, renameAccountQuery } from './queries/accounts';

export const listAccounts = createServerFn().handler(() => listAccountsQuery());

export const renameAccount = createServerFn({ method: 'POST' })
  .validator((input: { id: string; name: string | null }) => input)
  .handler(({ data }) => renameAccountQuery(data));
