import { cn } from '~/lib/utils';
import { formatCents, formatDate } from '~/lib/format';
import { Badge } from '~/components/ui/badge';
import type { TxRow } from '~/server/queries/transactions';
import { REGISTER_GRID } from './columns';

type RegisterRowProps = {
  row: TxRow;
  showAccountColumn: boolean;
  /** Absolute positioning + translateY, computed by the virtualizer in <Register/>. */
  style: React.CSSProperties;
  /** Arrived here from the spending page's drill-down — ring it so it's findable on a dense page. */
  highlighted?: boolean;
  /** Double-click opens the row editor, YNAB-style. */
  onEdit: () => void;
};

export function RegisterRow({
  row,
  showAccountColumn,
  style,
  highlighted,
  onEdit,
}: RegisterRowProps) {
  return (
    <div
      style={style}
      onDoubleClick={onEdit}
      className={cn(
        'grid cursor-default items-center gap-3 border-b px-3 text-sm hover:bg-muted/50',
        showAccountColumn ? REGISTER_GRID.withAccount : REGISTER_GRID.withoutAccount,
        highlighted && 'bg-primary/10 ring-1 ring-primary/50 ring-inset hover:bg-primary/15',
      )}
    >
      {showAccountColumn && (
        <div className="truncate text-muted-foreground" title={row.accountLabel}>
          {row.accountLabel}
        </div>
      )}
      <div className="tabular-nums text-muted-foreground">{formatDate(row.date)}</div>
      <PayeeCell row={row} />
      <CategoryCell row={row} />
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate" title={row.description}>
          {row.description}
        </span>
        {/* Hand-entered reconciliation rows aren't on any bank statement and the scraper never
            touches them — worth flagging inline so they don't read as a scraping artifact. */}
        {row.reconcile && (
          <Badge variant="outline" className="shrink-0">
            manual
          </Badge>
        )}
      </div>
      <div className="truncate text-right tabular-nums">
        {row.amountCents < 0 ? formatCents(-row.amountCents) : ''}
      </div>
      <div className="truncate text-right tabular-nums text-emerald-600 dark:text-emerald-400">
        {row.amountCents > 0 ? formatCents(row.amountCents) : ''}
      </div>
    </div>
  );
}

function PayeeCell({ row }: { row: TxRow }) {
  // Read-only in v1: nothing writes `transfer_bank_account_id` yet, so this branch is correct but
  // unexercised — every row in the database has a null transfer account today.
  if (row.transferAccountLabel) {
    return (
      <div
        className="truncate text-muted-foreground"
        title={`Transfer: ${row.transferAccountLabel}`}
      >
        Transfer: {row.transferAccountLabel}
      </div>
    );
  }
  if (!row.payeeName) {
    return <div className="text-muted-foreground">—</div>;
  }
  return (
    <div className="truncate" title={row.payeeName}>
      {row.payeeName}
    </div>
  );
}

function CategoryCell({ row }: { row: TxRow }) {
  if (!row.categoryId) {
    // YNAB's amber "needs a category" pill. Not `destructive` — an uncategorized transaction is a
    // to-do, not an error.
    return (
      <div className="min-w-0">
        <Badge className="max-w-full truncate border-transparent bg-amber-400 text-amber-950 dark:bg-amber-500 dark:text-amber-950">
          This needs a category
        </Badge>
      </div>
    );
  }
  const label = row.categoryGroupName
    ? `${row.categoryGroupName}: ${row.categoryName}`
    : (row.categoryName ?? '');
  return (
    <div className="truncate" title={label}>
      {label}
    </div>
  );
}
