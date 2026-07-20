import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { renameAccount } from '~/server/accounts';
import type { AccountSummary } from '~/server/queries/accounts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Button } from '~/components/ui/button';

type RenameAccountDialogProps = {
  account: AccountSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// Error surfacing is intentionally NOT handled here — src/start.ts's global function middleware
// already toasts every POST failure, so a per-call error banner would just duplicate it.
export function RenameAccountDialog({ account, open, onOpenChange }: RenameAccountDialogProps) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();

  // Re-seed the input from the current account's name every time the dialog opens, so reopening
  // it (for the same or a different account) never shows a stale edit from a prior cancel.
  useEffect(() => {
    if (open) {
      setName(account?.name ?? '');
    }
  }, [open, account]);

  const mutation = useMutation({
    mutationFn: (input: { id: string; name: string | null }) => renameAccount({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onOpenChange(false);
    },
  });

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!account) {
      return;
    }
    mutation.mutate({ id: account.id, name });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename account</DialogTitle>
            <DialogDescription>
              {account
                ? `${account.accountNumber} — leave blank to show the account number instead.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={account?.accountNumber}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
