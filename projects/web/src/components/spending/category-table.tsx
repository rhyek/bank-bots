import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '~/lib/utils';
import { formatCents } from '~/lib/format';
import { Skeleton } from '~/components/ui/skeleton';
import type { MonthSummary, SpendingBucket } from '~/server/queries/spending';

type OnDrill = (bucket: SpendingBucket, title: string) => void;

/**
 * Category group → category, sorted by spend descending at both levels.
 *
 * Rows carry NET activity (spending minus refunds), so a refund reduces its own category rather
 * than showing up as income — the same convention as YNAB's Activity column. Categories with no
 * activity in the month are absent entirely: this is a report, not a budget, so an empty row has
 * nothing to say.
 */
export function CategoryTable({
  summary,
  onDrill,
}: {
  summary: MonthSummary | undefined;
  onDrill: OnDrill;
}) {
  // Collapsed groups only — so a group that appears after a month change starts expanded, which is
  // the YNAB default and the more useful one.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (groupId: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(groupId)) {
        next.add(groupId);
      }
      return next;
    });

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border">
      <div className="sticky top-0 z-10 grid grid-cols-[1fr_140px] items-center gap-3 border-b bg-background px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <div>Category</div>
        <div className="text-right">Activity</div>
      </div>

      {!summary ? (
        <SkeletonRows />
      ) : summary.groups.length === 0 && !summary.uncategorized ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          No transactions in this month
        </p>
      ) : (
        <>
          {summary.groups.map((group) => (
            <div key={group.id}>
              <Row
                indent={false}
                expanded={!collapsed.has(group.id)}
                onToggle={() => toggle(group.id)}
                label={group.name}
                cents={group.netCents}
                bold
                onDrill={() => onDrill({ kind: 'group', groupId: group.id }, group.name)}
              />
              {!collapsed.has(group.id) &&
                group.categories.map((item) => (
                  <Row
                    key={item.id}
                    indent
                    label={item.name}
                    cents={item.netCents}
                    count={item.txCount}
                    onDrill={() =>
                      onDrill(
                        { kind: 'category', categoryId: item.id },
                        `${group.name}: ${item.name}`,
                      )
                    }
                  />
                ))}
            </div>
          ))}

          {/* Uncategorized feeds the header totals, so it belongs in this table rather than beside
              it — but it sits last, and is styled as a to-do rather than a category. */}
          {summary.uncategorized && (
            <Row
              indent={false}
              label="Uncategorized"
              cents={summary.uncategorized.netCents}
              count={summary.uncategorized.txCount}
              muted
              onDrill={() => onDrill({ kind: 'uncategorized' }, 'Uncategorized')}
            />
          )}
        </>
      )}
    </div>
  );
}

function Row({
  label,
  cents,
  count,
  indent,
  bold,
  muted,
  expanded,
  onToggle,
  onDrill,
}: {
  label: string;
  cents: number;
  count?: number;
  indent: boolean;
  bold?: boolean;
  muted?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onDrill: () => void;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[1fr_140px] items-center gap-3 border-b px-3 text-sm last:border-b-0',
        bold && 'bg-muted/40 font-medium',
      )}
    >
      <div className={cn('flex min-w-0 items-center gap-1 py-2', indent && 'ps-6')}>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
            className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        )}
        <span className={cn('truncate', muted && 'text-muted-foreground')} title={label}>
          {label}
        </span>
        {count !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground">({count})</span>
        )}
      </div>
      <button
        type="button"
        onClick={onDrill}
        className="rounded-sm py-2 text-right tabular-nums underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {formatCents(cents)}
      </button>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div>
      {Array.from({ length: 10 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 border-b px-3 py-2">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}
