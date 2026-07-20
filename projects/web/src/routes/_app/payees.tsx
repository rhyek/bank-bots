import { useMemo, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Input } from '~/components/ui/input';
import { Skeleton } from '~/components/ui/skeleton';
import { Header } from '~/components/layout/header';
import { Main } from '~/components/layout/main';
import { ThemeSwitch } from '~/components/theme-switch';
import { formatCents, formatDate } from '~/lib/format';
import { payeeSummariesQueryOptions } from '~/lib/queries';

export const Route = createFileRoute('/_app/payees')({ component: Payees });

const GRID = 'grid-cols-[minmax(180px,1fr)_100px_140px_120px]';

function Payees() {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const { data: payees, isPending } = useQuery(payeeSummariesQueryOptions());

  // ~685 rows: small enough to filter and render without virtualizing, unlike the register.
  const rows = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (!needle) {
      return payees ?? [];
    }
    return (payees ?? []).filter((payee) => payee.name.toLowerCase().includes(needle));
  }, [payees, term]);

  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Payees</h1>
        <div className="ms-auto">
          <ThemeSwitch />
        </div>
      </Header>
      <Main fixed fluid className="h-[calc(100svh-4rem)]">
        <div className="flex items-center gap-2 pb-3">
          <div className="relative w-64">
            <Search className="text-muted-foreground absolute start-2 top-1/2 size-4 -translate-y-1/2" />
            <Input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Filter payees"
              className="ps-8"
            />
          </div>
          {!isPending && (
            <span className="text-muted-foreground text-sm">
              {rows.length} of {payees?.length ?? 0}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <div
            className={`bg-background text-muted-foreground sticky top-0 z-10 grid ${GRID} items-center gap-3 border-b px-3 py-2 text-xs font-medium tracking-wide uppercase`}
          >
            <div>Payee</div>
            <div className="text-right">Transactions</div>
            <div className="text-right">Total</div>
            <div className="text-right">Last seen</div>
          </div>

          {isPending ? (
            Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="border-b px-3 py-2">
                <Skeleton className="h-4 w-full" />
              </div>
            ))
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground p-8 text-center text-sm">No payees match.</p>
          ) : (
            rows.map((payee) => (
              <button
                key={payee.id}
                type="button"
                // Jumps to every transaction for this payee. Searching by NAME rather than id keeps
                // the register's filter model to one text field instead of a payee-id special case.
                onClick={() =>
                  void navigate({
                    to: '/accounts',
                    search: { window: 'all', search: payee.name, unmatchedOnly: false },
                  })
                }
                className={`grid ${GRID} hover:bg-muted/50 w-full items-center gap-3 border-b px-3 py-2 text-start text-sm`}
              >
                <span className="truncate" title={payee.name}>
                  {payee.name}
                </span>
                <span className="text-right tabular-nums">{payee.txCount}</span>
                <span className="text-right tabular-nums">{formatCents(payee.totalCents)}</span>
                <span className="text-muted-foreground text-right tabular-nums">
                  {payee.lastDate ? formatDate(payee.lastDate) : '—'}
                </span>
              </button>
            ))
          )}
        </div>
      </Main>
    </>
  );
}
