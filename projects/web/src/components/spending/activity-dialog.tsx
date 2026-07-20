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
import { Skeleton } from '~/components/ui/skeleton';
import type { SpendingBucket } from '~/server/queries/spending';

export type Drilldown = { bucket: SpendingBucket; title: string };

/**
 * The transactions behind one figure on the spending page.
 *
 * A dialog rather than a popover because buckets get large — January's `Variable: Miscellaneous`
 * alone holds 37 transactions — and a popover that tall is unusable.
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
  const { data: rows, isPending } = useQuery(
    bucketTransactionsQueryOptions(month, drilldown?.bucket ?? null),
  );

  /**
   * Hand off to the register, scoped to this month and pointing at the row.
   *
   * The window is set to the month rather than left alone so the target is a page or two into the
   * result set — the register seeks by fetching pages until it finds the id, which an "all dates"
   * window would turn into a walk through the whole table.
   */
  const openInRegister = (txId: string) => {
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
            select one to open it in the register
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-auto rounded-md border">
          <div className="sticky top-0 z-10 grid grid-cols-[minmax(90px,120px)_100px_minmax(120px,1fr)_minmax(140px,1.5fr)_110px] items-center gap-3 border-b bg-background px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <div>Account</div>
            <div>Date</div>
            <div>Payee</div>
            <div>Description</div>
            <div className="text-right">Amount</div>
          </div>

          {isPending ? (
            <SkeletonRows />
          ) : rows?.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No transactions</p>
          ) : (
            rows?.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => openInRegister(row.id)}
                className="grid w-full grid-cols-[minmax(90px,120px)_100px_minmax(120px,1fr)_minmax(140px,1.5fr)_110px] items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
                <span
                  className={cn(
                    'text-right tabular-nums',
                    row.amountCents > 0 && 'text-emerald-600 dark:text-emerald-400',
                  )}
                >
                  {formatCents(row.amountCents)}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
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
