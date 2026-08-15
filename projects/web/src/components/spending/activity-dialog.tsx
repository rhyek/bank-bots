import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { formatCents, formatDate } from '~/lib/format';
import { monthRange } from '~/lib/filters';
import { bucketTransactionsQueryOptions } from '~/lib/queries';
import { cn } from '~/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Checkbox } from '~/components/ui/checkbox';
import { Skeleton } from '~/components/ui/skeleton';
import type { SpendingBucket } from '~/server/queries/spending';
import type { TxRow } from '~/server/queries/tx-row';

export type Drilldown = { bucket: SpendingBucket; title: string };

// Two grid templates that share the same trailing amount column (110px) + px-3 + gap-3, so amounts
// line up on the right whether a row is flat, a payee subtotal, or a payee's child transaction.
const FLAT_GRID =
  'grid-cols-[minmax(90px,120px)_100px_minmax(120px,1fr)_minmax(140px,1.5fr)_110px]';
const CHILD_GRID = 'grid-cols-[minmax(90px,120px)_100px_minmax(140px,1fr)_110px]';

const NONE_KEY = '__none__';

type PayeeGroup = { key: string; name: string; rows: TxRow[]; subtotalCents: number };

/**
 * Group a bucket's transactions by payee, biggest total first.
 *
 * Sorted by absolute subtotal so the heaviest payee leads regardless of an inflow/outflow bucket's
 * sign; the "No payee" catch-all is pinned last rather than ranked by size. Rows arrive date-desc
 * from the query and stay that way within a group.
 */
function groupByPayee(rows: TxRow[]): PayeeGroup[] {
  const groups = new Map<string, PayeeGroup>();
  for (const row of rows) {
    const key = row.payeeId ?? NONE_KEY;
    const group = groups.get(key) ?? {
      key,
      name: row.payeeName ?? 'No payee',
      rows: [],
      subtotalCents: 0,
    };
    group.rows.push(row);
    group.subtotalCents += row.amountCents;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if ((a.key === NONE_KEY) !== (b.key === NONE_KEY)) {
      return a.key === NONE_KEY ? 1 : -1;
    }
    return Math.abs(b.subtotalCents) - Math.abs(a.subtotalCents);
  });
}

function amountClass(cents: number) {
  return cn('text-right tabular-nums', cents > 0 && 'text-emerald-600 dark:text-emerald-400');
}

/**
 * The transactions behind one figure on the spending page.
 *
 * A dialog rather than a popover because buckets get large — January's `Variable: Miscellaneous`
 * alone holds 37 transactions — and a popover that tall is unusable. Defaults to grouping by payee,
 * which collapses the repeated payee column into one subtotalled row per merchant.
 */
export function ActivityDialog({
  month,
  drilldown,
  onClose,
}: {
  month: string;
  drilldown: Drilldown | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [groupByPayeeOn, setGroupByPayeeOn] = useState(true);
  const { data: rows, isPending } = useQuery(
    bucketTransactionsQueryOptions(month, drilldown?.bucket ?? null),
  );

  /**
   * Hand off to the transactions page, scoped to this month and pointing at the row.
   *
   * The window is set to the month rather than left alone so the target is a page or two into the
   * result set — the list seeks by fetching pages until it finds the id, which an "all dates"
   * window would turn into a walk through the whole table.
   */
  const openInTransactions = (txId: string) => {
    const range = monthRange(month);
    onClose();
    void navigate({
      to: '/accounts',
      search: {
        window: 'custom' as const,
        from: range.from,
        to: range.to,
        unmatchedOnly: false,
        highlight: txId,
      },
    });
  };

  const groups = rows && groupByPayeeOn ? groupByPayee(rows) : null;

  return (
    <Dialog open={drilldown !== null} onOpenChange={(open) => !open && onClose()}>
      {/* `sm:` matters: the vendored DialogContent sets `sm:max-w-lg`, and tailwind-merge treats a
          responsive variant and a base utility as separate declarations — so a plain `max-w-3xl`
          here would lose to it at every width above `sm` and clip the amount column. */}
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{drilldown?.title}</DialogTitle>
          <DialogDescription>
            {rows ? `${rows.length} transaction${rows.length === 1 ? '' : 's'} — ` : ''}
            select one to open it in the transactions list
          </DialogDescription>
        </DialogHeader>

        <label className="flex w-fit items-center gap-2 text-sm select-none">
          <Checkbox
            checked={groupByPayeeOn}
            onCheckedChange={(value) => setGroupByPayeeOn(value === true)}
          />
          Group by payee
        </label>

        <div className="max-h-[60vh] overflow-auto rounded-md border">
          <div
            className={cn(
              'sticky top-0 z-10 grid items-center gap-3 border-b bg-background px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase',
              groupByPayeeOn ? CHILD_GRID : FLAT_GRID,
            )}
          >
            <div>Account</div>
            <div>Date</div>
            {!groupByPayeeOn && <div>Payee</div>}
            <div>Description</div>
            <div className="text-right">Amount</div>
          </div>

          {isPending ? (
            <SkeletonRows />
          ) : rows?.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No transactions</p>
          ) : groups ? (
            groups.map((group) => (
              <div key={group.key}>
                <div className="grid grid-cols-[1fr_110px] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-sm font-medium">
                  <span className="truncate" title={group.name}>
                    {group.name}
                    <span className="ms-1 text-xs text-muted-foreground">
                      ({group.rows.length})
                    </span>
                  </span>
                  <span className={amountClass(group.subtotalCents)}>
                    {formatCents(group.subtotalCents)}
                  </span>
                </div>
                {group.rows.map((row) => (
                  <ChildRow key={row.id} row={row} onClick={() => openInTransactions(row.id)} />
                ))}
              </div>
            ))
          ) : (
            rows?.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => openInTransactions(row.id)}
                className={cn(
                  'grid w-full items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  FLAT_GRID,
                )}
              >
                <span className="truncate text-muted-foreground" title={row.accountLabel}>
                  {row.accountLabel}
                </span>
                <span className="tabular-nums text-muted-foreground">{formatDate(row.date)}</span>
                <span className="truncate" title={row.payeeName ?? undefined}>
                  {row.payeeName ?? '—'}
                </span>
                <span className="truncate text-muted-foreground" title={row.description}>
                  {row.description}
                </span>
                <span className={amountClass(row.amountCents)}>{formatCents(row.amountCents)}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One transaction under a payee group — same columns as the flat row, minus the payee. */
function ChildRow({ row, onClick }: { row: TxRow; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'grid w-full items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        CHILD_GRID,
      )}
    >
      <span className="truncate text-muted-foreground" title={row.accountLabel}>
        {row.accountLabel}
      </span>
      <span className="tabular-nums text-muted-foreground">{formatDate(row.date)}</span>
      <span className="truncate text-muted-foreground" title={row.description}>
        {row.description}
      </span>
      <span className={amountClass(row.amountCents)}>{formatCents(row.amountCents)}</span>
    </button>
  );
}

function SkeletonRows() {
  return (
    <div>
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 border-b px-3 py-2">
          <Skeleton className="h-4 flex-1" />
        </div>
      ))}
    </div>
  );
}
