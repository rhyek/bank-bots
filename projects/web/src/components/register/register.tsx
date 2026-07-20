import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '~/lib/utils';
import type { TxFilters } from '~/lib/filters';
import { listTransactions } from '~/server/transactions';
import { Skeleton } from '~/components/ui/skeleton';
import { RegisterRow } from './register-row';
import { RowEditor } from './row-editor';
import { HEADER_HEIGHT, REGISTER_GRID, REGISTER_MIN_WIDTH, ROW_HEIGHT } from './columns';

type RegisterProps = {
  filters: TxFilters;
  showAccountColumn?: boolean;
  /**
   * A transaction to scroll to and ring — how the spending page hands off to the register.
   *
   * Deliberately separate from `filters`: `filters` is the React Query key, so carrying this inside
   * it would discard every loaded page and refetch the list each time the highlight changed.
   */
  highlight?: string;
};

/** Start fetching the next page once the last rendered row is within this many rows of the end. */
const PREFETCH_THRESHOLD = 10;

/**
 * How far the seek below will page looking for `highlight` before giving up.
 *
 * `hasNextPage` already stops it at the end of the filtered set, which for the intended arrival
 * (a month-scoped window) is one or two pages. This is the second bound, for a `highlight` that
 * isn't in the current result set at all — a hand-edited URL, or a filter changed after arriving —
 * where the first bound alone would walk the entire table.
 */
const MAX_SEEK_ROWS = 2000;

export function Register({ filters, showAccountColumn = false, highlight }: RegisterProps) {
  // Only one row edits at a time, YNAB-style. Held here rather than in the row so that
  // opening a second editor implicitly closes the first.
  const [editingId, setEditingId] = useState<string | null>(null);

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

  const highlightIndex = highlight ? rows.findIndex((row) => row.id === highlight) : -1;

  // Page forward until the highlighted row is loaded. Bounded by `hasNextPage` and MAX_SEEK_ROWS.
  useEffect(() => {
    if (!highlight || highlightIndex !== -1 || rows.length >= MAX_SEEK_ROWS) {
      return;
    }
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [highlight, highlightIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Scroll to it once it exists. Keyed on the id rather than a boolean so that arriving at a
  // different transaction scrolls again, while paging or editing around the current one does not
  // yank the viewport back.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!highlight || highlightIndex === -1 || scrolledTo.current === highlight) {
      return;
    }
    scrolledTo.current = highlight;
    virtualizer.scrollToIndex(highlightIndex, { align: 'center' });
  }, [highlight, highlightIndex, virtualizer]);

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
          <div>Description</div>
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
            {virtualItems.map((virtualRow) => {
              const row = rows[virtualRow.index];
              const style: React.CSSProperties = {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              };

              return row.id === editingId ? (
                <RowEditor
                  key={row.id}
                  row={row}
                  showAccountColumn={showAccountColumn}
                  style={style}
                  onClose={() => setEditingId(null)}
                />
              ) : (
                <RegisterRow
                  key={row.id}
                  row={row}
                  showAccountColumn={showAccountColumn}
                  style={style}
                  highlighted={row.id === highlight}
                  onEdit={() => setEditingId(row.id)}
                />
              );
            })}
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
