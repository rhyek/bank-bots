import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Header } from '~/components/layout/header';
import { Main } from '~/components/layout/main';
import { ThemeSwitch } from '~/components/theme-switch';
import { Transactions } from '~/components/transactions/transactions';
import {
  TransactionsToolbar,
  type FilterPatch,
} from '~/components/transactions/transactions-toolbar';
import { transactionsSearchSchema } from '~/lib/filters';

export const Route = createFileRoute('/_app/unmatched')({
  component: Unmatched,
  validateSearch: (search: Record<string, unknown>) => transactionsSearchSchema(search, 'all'),
});

function Unmatched() {
  const { highlight, ...search } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const onChange = (patch: FilterPatch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Unmatched</h1>
        <div className="ms-auto">
          <ThemeSwitch />
        </div>
      </Header>
      <Main fixed fluid className="h-[calc(100svh-4rem)]">
        <TransactionsToolbar filters={search} onChange={onChange} />
        <Transactions
          filters={{ ...search, unmatchedOnly: true }}
          showAccountColumn
          highlight={highlight}
        />
      </Main>
    </>
  );
}
