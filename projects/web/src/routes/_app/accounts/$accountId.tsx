import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Skeleton } from '~/components/ui/skeleton';
import { Header } from '~/components/layout/header';
import { Main } from '~/components/layout/main';
import { ThemeSwitch } from '~/components/theme-switch';
import { Register } from '~/components/register/register';
import { RegisterToolbar, type FilterPatch } from '~/components/register/register-toolbar';
import { RenameAccountDialog } from '~/components/rename-account-dialog';
import { registerSearchSchema } from '~/lib/filters';
import { formatCents } from '~/lib/format';
import { accountsQueryOptions } from '~/lib/queries';

export const Route = createFileRoute('/_app/accounts/$accountId')({
  component: AccountRegister,
  validateSearch: registerSearchSchema,
});

function AccountRegister() {
  const { accountId } = Route.useParams();
  const { highlight, ...filters } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [renaming, setRenaming] = useState(false);

  const { data: accounts, isPending } = useQuery(accountsQueryOptions());
  const account = accounts?.find((candidate) => candidate.id === accountId);

  const onChange = (patch: FilterPatch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  return (
    <>
      <Header>
        {isPending ? (
          <Skeleton className="h-6 w-48" />
        ) : (
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="truncate text-lg font-semibold">
              {account?.label ?? 'Unknown account'}
            </h1>
            {account && (
              <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
                {formatCents(account.balanceCents)}
              </span>
            )}
          </div>
        )}
        <div className="ms-auto flex items-center gap-1">
          {account && (
            <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
              <Pencil className="size-4" />
              Rename
            </Button>
          )}
          <ThemeSwitch />
        </div>
      </Header>
      <Main fixed fluid className="h-[calc(100svh-4rem)]">
        <RegisterToolbar filters={filters} onChange={onChange} />
        {/* The account is fixed by the route, so its column would repeat the page title on every
            row — hence showAccountColumn is left off here. */}
        <Register filters={{ ...filters, accountId }} highlight={highlight} />
      </Main>

      <RenameAccountDialog account={account ?? null} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}
