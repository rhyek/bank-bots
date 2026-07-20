import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Landmark } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';
import { Header } from '~/components/layout/header';
import { Main } from '~/components/layout/main';
import { ThemeSwitch } from '~/components/theme-switch';
import { formatCents } from '~/lib/format';
import { accountsQueryOptions, unmatchedCountQueryOptions } from '~/lib/queries';
import { defaultSearch } from '~/lib/filters';

export const Route = createFileRoute('/_app/')({ component: Overview });

// ThemeSwitch lives per-page rather than in _app.tsx so each page composes its own Header.
function Overview() {
  const { data: accounts, isPending } = useQuery(accountsQueryOptions());
  const { data: unmatched } = useQuery(unmatchedCountQueryOptions());

  const total = accounts?.reduce((sum, account) => sum + account.balanceCents, 0) ?? 0;

  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Overview</h1>
        <div className="ms-auto">
          <ThemeSwitch />
        </div>
      </Header>
      <Main>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="sm:col-span-2 lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
                <Landmark className="size-4" />
                Total balance
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isPending ? (
                <Skeleton className="h-9 w-40" />
              ) : (
                <p className="text-3xl font-semibold tabular-nums">{formatCents(total)}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="size-4" />
                Needs a payee
              </CardTitle>
            </CardHeader>
            <CardContent>
              {unmatched === undefined ? (
                <Skeleton className="h-9 w-24" />
              ) : (
                <Link to="/unmatched" search={defaultSearch('all')} className="block">
                  <p className="text-3xl font-semibold tabular-nums hover:underline">{unmatched}</p>
                  <p className="text-muted-foreground mt-1 text-xs">transactions to review</p>
                </Link>
              )}
            </CardContent>
          </Card>
        </div>

        <h2 className="text-muted-foreground mt-8 mb-3 text-sm font-medium">Accounts</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {isPending
            ? Array.from({ length: 4 }).map((_, index) => (
                <Card key={index}>
                  <CardContent className="pt-6">
                    <Skeleton className="mb-2 h-4 w-32" />
                    <Skeleton className="h-7 w-24" />
                  </CardContent>
                </Card>
              ))
            : accounts?.map((account) => (
                <Link
                  key={account.id}
                  to="/accounts/$accountId"
                  params={{ accountId: account.id }}
                  search={defaultSearch()}
                >
                  <Card className="hover:border-primary/40 h-full transition-colors">
                    <CardContent className="pt-6">
                      <p className="text-muted-foreground truncate text-sm" title={account.label}>
                        {account.label}
                      </p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums">
                        {formatCents(account.balanceCents)}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
        </div>
      </Main>
    </>
  );
}
