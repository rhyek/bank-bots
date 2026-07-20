import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown } from 'lucide-react';
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <TriggerButton label={selected?.name ?? 'No payee'} muted={!selected} />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        {/* shouldFilter={false}: we filter ourselves so the cap applies to the MATCHES, not to an
            arbitrary first 100 that cmdk would then filter down to almost nothing. */}
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search payees…" value={term} onValueChange={setTerm} />
          <CommandList>
            <CommandEmpty>No payee found.</CommandEmpty>
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
