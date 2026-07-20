import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, X } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/utils';
import { formatCents, formatDate } from '~/lib/format';
import { updateTransaction } from '~/server/transactions';
import type { TxPage, TxRow } from '~/server/queries/transactions';
import { REGISTER_GRID } from './columns';
import { CategoryCombobox, PayeeCombobox } from './pickers';

const LOCKED_REASON =
  'Set by the bank scraper. This column is part of the key the scraper matches rows on, so editing it would duplicate this transaction on the next scrape.';

/** A read-only cell in edit mode, with the explanation one hover away. */
function LockedCell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'text-muted-foreground flex min-w-0 cursor-not-allowed items-center gap-1',
            className,
          )}
        >
          <span className="truncate">{children}</span>
          <Lock className="size-3 shrink-0 opacity-40" />
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{LOCKED_REASON}</TooltipContent>
    </Tooltip>
  );
}

export function RowEditor({
  row,
  showAccountColumn,
  style,
  onClose,
}: {
  row: TxRow;
  showAccountColumn: boolean;
  style: React.CSSProperties;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [payeeId, setPayeeId] = useState(row.payeeId);
  const [categoryId, setCategoryId] = useState(row.categoryId);
  const [memo, setMemo] = useState(row.memo ?? '');

  const mutation = useMutation({
    mutationFn: () =>
      updateTransaction({ data: { id: row.id, payeeId, categoryId, memo: memo || null } }),

    onMutate: async () => {
      // Stop in-flight refetches from overwriting the optimistic patch when they land.
      await queryClient.cancelQueries({ queryKey: ['transactions'] });
      const previous = queryClient.getQueriesData<{ pages: TxPage[] }>({
        queryKey: ['transactions'],
      });

      queryClient.setQueriesData<{ pages: TxPage[]; pageParams: unknown[] }>(
        { queryKey: ['transactions'] },
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              rows: page.rows.map((candidate) =>
                candidate.id === row.id
                  ? { ...candidate, payeeId, categoryId, memo: memo || null }
                  : candidate,
              ),
            })),
          },
      );

      return { previous };
    },

    onError: (_error, _variables, context) => {
      // Roll back. The failure itself is already surfaced by the global server-fn middleware in
      // src/start.ts, which toasts every POST rejection — no banner needed here.
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },

    // Refetch regardless of outcome: the optimistic patch carries ids, but the row's payee NAME and
    // category GROUP are resolved by joins that only the server can do.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['transactions'] }),

    onSuccess: onClose,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
      if (event.key === 'Enter' && !mutation.isPending) {
        mutation.mutate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div
      style={style}
      className={cn(
        'bg-muted/60 ring-primary/40 grid items-center gap-3 border-b px-3 text-sm ring-1 ring-inset',
        showAccountColumn ? REGISTER_GRID.withAccount : REGISTER_GRID.withoutAccount,
      )}
    >
      {showAccountColumn && <LockedCell>{row.accountLabel}</LockedCell>}
      <LockedCell className="tabular-nums">{formatDate(row.date)}</LockedCell>

      <PayeeCombobox value={payeeId} onSelect={setPayeeId} />
      <CategoryCombobox value={categoryId} onSelect={setCategoryId} />

      <div className="flex min-w-0 items-center gap-1">
        <Input
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
          placeholder={row.description}
          className="h-7 px-2"
        />
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
          aria-label="Save"
        >
          <Check className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          onClick={onClose}
          aria-label="Cancel"
        >
          <X className="size-4" />
        </Button>
      </div>

      <LockedCell className="justify-end tabular-nums">
        {row.amountCents < 0 ? formatCents(-row.amountCents) : ''}
      </LockedCell>
      <LockedCell className="justify-end tabular-nums">
        {row.amountCents > 0 ? formatCents(row.amountCents) : ''}
      </LockedCell>
    </div>
  );
}
