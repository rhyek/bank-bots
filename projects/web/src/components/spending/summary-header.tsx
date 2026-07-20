import { cn } from '~/lib/utils';
import { formatCents } from '~/lib/format';
import { Skeleton } from '~/components/ui/skeleton';
import type { MonthSummary, SpendingBucket } from '~/server/queries/spending';

/**
 * The month's three figures. Each opens the drill-down for the transactions behind it.
 *
 * "Left over" is inflow − outflow rather than a running balance: it is the figure that stays
 * comparable month to month, and it reproduces what the owner's YNAB budget tracked in its Savings
 * category ($4,623.04 assigned in January 2026 against $4,626.18 net here).
 */
export function SummaryHeader({
  summary,
  onDrill,
}: {
  summary: MonthSummary | undefined;
  onDrill: (bucket: SpendingBucket, title: string) => void;
}) {
  if (!summary) {
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="rounded-md border p-4">
            <Skeleton className="mb-2 h-3 w-16" />
            <Skeleton className="h-7 w-32" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Figure
        label="Inflow"
        cents={summary.inflowCents}
        className="text-emerald-600 dark:text-emerald-400"
        onClick={() => onDrill({ kind: 'inflow' }, 'Inflow')}
      />
      <Figure
        label="Outflow"
        cents={-summary.outflowCents}
        onClick={() => onDrill({ kind: 'outflow' }, 'Outflow')}
      />
      <Figure
        label="Left over"
        cents={summary.netCents}
        className={cn(
          'font-semibold',
          summary.netCents < 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400',
        )}
        onClick={() => onDrill({ kind: 'all' }, 'All transactions')}
      />
    </div>
  );
}

function Figure({
  label,
  cents,
  className,
  onClick,
}: {
  label: string;
  cents: number;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className={cn('text-2xl tabular-nums', className)}>{formatCents(cents)}</div>
    </button>
  );
}
