import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '~/lib/utils';
import type { TxFilters } from '~/lib/filters';
import { listTransactions } from '~/server/transactions';
import { Skeleton } from '~/components/ui/skeleton';
import { RegisterRow } from './register-row';
import { HEADER_HEIGHT, REGISTER_GRID, REGISTER_MIN_WIDTH, ROW_HEIGHT } from './columns';

type RegisterProps = {
  filters: TxFilters;
  showAccountColumn?: boolean;
};

/** Start fetching the next page once the last rendered row is within this many rows of the end. */
const PREFETCH_THRESHOLD = 10;

export function Register({ filters, showAccountColumn = false }: RegisterProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(0);

  const { data, isPending, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    // `filters` is part of the key, so changing a filter starts a fresh infinite query instead of
    // appending pages from the old one.
    queryKey: ['transactions', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listTransactions({ data: { filters, cursor: pageParam, pageSize: 100 } }),
    // `?? undefined` is load-bearing: `null` is a legal page param, so returning the server's
    // terminal `nextCursor: null` verbatim would leave `hasNextPage` true forever and spin.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const rows = data?.pages.flatMap((page) => page.rows) ?? [];

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // The sticky column header sits inside the scroll container and pushes the list down; without
    // this the virtualizer would place every row one header-height too high.
    scrollMargin: HEADER_HEIGHT,
  });

  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    const last = virtualItems.at(-1);
    if (!last || !hasNextPage || isFetchingNextPage) {
      return;
    }
    if (last.index >= rows.length - PREFETCH_THRESHOLD) {
      void fetchNextPage();
    }
  }, [virtualItems, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Measured so the first paint fills the viewport with skeletons rather than a fixed guess. The
  // whole app is client-fetched, so this loading state is the first thing anyone sees.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    setViewportHeight(element.clientHeight);
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const gridClass = showAccountColumn ? REGISTER_GRID.withAccount : REGISTER_GRID.withoutAccount;
  const minWidthClass = showAccountColumn
    ? REGISTER_MIN_WIDTH.withAccount
    : REGISTER_MIN_WIDTH.withoutAccount;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-md border">
      <div className={cn('relative', minWidthClass)}>
        <div
          style={{ height: `${HEADER_HEIGHT}px` }}
          className={cn(
            'sticky top-0 z-10 grid items-center gap-3 border-b bg-background px-3',
            'text-xs font-medium tracking-wide text-muted-foreground uppercase',
            gridClass,
          )}
        >
          {showAccountColumn && <div>Account</div>}
          <div>Date</div>
          <div>Payee</div>
          <div>Category</div>
          <div>Memo</div>
          <div className="text-right">Outflow</div>
          <div className="text-right">Inflow</div>
        </div>

        {isPending ? (
          <SkeletonRows count={Math.max(1, Math.ceil(viewportHeight / ROW_HEIGHT))} />
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No transactions in this period
          </p>
        ) : (
          <div style={{ height: `${virtualizer.getTotalSize()}px` }} className="relative">
            {virtualItems.map((virtualRow) => (
              <RegisterRow
                key={rows[virtualRow.index].id}
                row={rows[virtualRow.index]}
                showAccountColumn={showAccountColumn}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          style={{ height: `${ROW_HEIGHT}px` }}
          className="flex items-center gap-3 border-b px-3"
        >
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  );
}
