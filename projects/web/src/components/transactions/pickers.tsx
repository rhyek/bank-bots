import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';
import { categoriesQueryOptions, payeesQueryOptions } from '~/lib/queries';
import { createPayee } from '~/server/lookups';
import type { PayeeOption } from '~/server/queries/lookups';

/**
 * cmdk filters and renders every item it is given. With 685 payees that is a visible cost on each
 * keystroke, so the list is capped and the user is told when there is more behind the cap.
 */
const MAX_VISIBLE = 100;

const NONE = '__none__';

/**
 * `PopoverTrigger asChild` clones this element and injects its own `onClick`, `ref` and aria props.
 * Those MUST be spread onto the real DOM button — a wrapper that ignores incoming props swallows
 * them and the popover silently never opens.
 */
function TriggerButton({
  label,
  muted,
  ...props
}: { label: string; muted: boolean } & React.ComponentProps<typeof Button>) {
  return (
    <Button
      {...props}
      variant="outline"
      size="sm"
      role="combobox"
      className={cn(
        'h-7 w-full justify-between px-2 font-normal',
        muted && 'text-muted-foreground',
      )}
    >
      <span className="truncate">{label}</span>
      <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
    </Button>
  );
}

export function PayeeCombobox({
  value,
  onSelect,
}: {
  value: string | null;
  onSelect: (payeeId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: payees } = useQuery(payeesQueryOptions());

  const matches = useMemo(() => {
    const all = payees ?? [];
    const needle = term.trim().toLowerCase();
    const filtered = needle
      ? all.filter((payee) => payee.name.toLowerCase().includes(needle))
      : all;
    return { visible: filtered.slice(0, MAX_VISIBLE), total: filtered.length };
  }, [payees, term]);

  const selected = payees?.find((payee) => payee.id === value);

  const trimmed = term.trim();
  // Offer "Create" only when the text has no exact (case-insensitive) match — an existing payee is
  // already selectable from the list, so creating would just duplicate it.
  const exactExists =
    trimmed !== '' && (payees ?? []).some((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  const showCreate = trimmed !== '' && !exactExists;

  const create = useMutation({
    mutationFn: (name: string) => createPayee({ data: { name } }),
    onSuccess: (created: PayeeOption) => {
      // Seed the cache so the new payee is usable immediately: payeesQueryOptions has a 5-minute
      // staleTime, so without this the trigger would read "No payee" until a refetch. Insert in name
      // order to match listPayeesQuery; the invalidation then reconciles with the server.
      queryClient.setQueryData<PayeeOption[]>(['payees'], (old) => {
        if (!old) {
          return [created];
        }
        if (old.some((p) => p.id === created.id)) {
          return old; // an existing payee was reused, not created
        }
        return [...old, created].sort((a, b) => a.name.localeCompare(b.name));
      });
      void queryClient.invalidateQueries({ queryKey: ['payees'] });
      onSelect(created.id);
      setTerm('');
      setOpen(false);
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TriggerButton label={selected?.name ?? 'No payee'} muted={!selected} />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        {/* shouldFilter={false}: we filter ourselves so the cap applies to the MATCHES, not to an
            arbitrary first 100 that cmdk would then filter down to almost nothing. */}
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search or create…" value={term} onValueChange={setTerm} />
          <CommandList>
            <CommandEmpty>No payee found.</CommandEmpty>
            {showCreate && (
              <CommandGroup>
                <CommandItem
                  value={`__create__${trimmed}`}
                  disabled={create.isPending}
                  onSelect={() => create.mutate(trimmed)}
                >
                  <Plus className="size-4" />
                  <span className="truncate">
                    Create <span className="font-medium">“{trimmed}”</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              <CommandItem
                value={NONE}
                onSelect={() => {
                  onSelect(null);
                  setOpen(false);
                }}
              >
                <Check className={cn('size-4', value ? 'opacity-0' : 'opacity-100')} />
                <span className="text-muted-foreground">No payee</span>
              </CommandItem>
              {matches.visible.map((payee) => (
                <CommandItem
                  key={payee.id}
                  value={payee.id}
                  onSelect={() => {
                    onSelect(payee.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn('size-4', value === payee.id ? 'opacity-100' : 'opacity-0')}
                  />
                  {payee.name}
                </CommandItem>
              ))}
            </CommandGroup>
            {matches.total > MAX_VISIBLE && (
              <p className="text-muted-foreground px-3 py-2 text-xs">
                Showing {MAX_VISIBLE} of {matches.total} — refine your search.
              </p>
            )}
          </CommandList>
          {/* YNAB's "Manage Payees". Leaves the editor (route change), which is the intended exit. */}
          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void navigate({ to: '/payees' });
              }}
              className="text-primary hover:bg-muted w-full rounded-sm px-2 py-1.5 text-left text-sm"
            >
              Manage payees
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function CategoryCombobox({
  value,
  onSelect,
}: {
  value: string | null;
  onSelect: (categoryId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: categories } = useQuery(categoriesQueryOptions());

  const selected = categories?.find((category) => category.id === value);

  // Preserve the query's ordering (group name, then category name) while grouping for display.
  const groups = useMemo(() => {
    const byGroup = new Map<string, typeof categories>();
    for (const category of categories ?? []) {
      const existing = byGroup.get(category.groupName) ?? [];
      existing.push(category);
      byGroup.set(category.groupName, existing);
    }
    return [...byGroup.entries()];
  }, [categories]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TriggerButton
          label={selected ? `${selected.groupName}: ${selected.name}` : 'No category'}
          muted={!selected}
        />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search categories…" />
          <CommandList>
            <CommandEmpty>No category found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="No category"
                onSelect={() => {
                  onSelect(null);
                  setOpen(false);
                }}
              >
                <Check className={cn('size-4', value ? 'opacity-0' : 'opacity-100')} />
                <span className="text-muted-foreground">No category</span>
              </CommandItem>
            </CommandGroup>
            {groups.map(([groupName, items]) => (
              <CommandGroup key={groupName} heading={groupName}>
                {(items ?? []).map((category) => (
                  <CommandItem
                    key={category.id}
                    // cmdk matches on `value`, so include the group name to make "Fixed" find its
                    // whole group rather than nothing.
                    value={`${groupName} ${category.name}`}
                    onSelect={() => {
                      onSelect(category.id);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn('size-4', value === category.id ? 'opacity-100' : 'opacity-0')}
                    />
                    {category.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
