import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { cn } from '~/lib/utils';
import { monthEnd, monthStart, WINDOW_LABELS, type TxFilters } from '~/lib/filters';

const PRESETS = Object.keys(WINDOW_LABELS) as (keyof typeof WINDOW_LABELS)[];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Widest plausible range: the oldest transaction is 2022-01-01. */
const FIRST_YEAR = 2022;

function yearOptions() {
  const thisYear = new Date().getFullYear();
  return Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
}

/** Split 'YYYY-MM-DD' into its month/year parts for the selects. */
function parts(iso: string | undefined, fallback: { month: number; year: number }) {
  if (!iso) {
    return fallback;
  }
  const [year, month] = iso.split('-').map(Number);
  return { month, year };
}

export type FilterPatch = Partial<Pick<TxFilters, 'window' | 'from' | 'to' | 'search'>>;

/**
 * The View Options popover + search box, mirroring YNAB's.
 *
 * It holds no filter state of its own — every change is pushed up to the route, which writes it to
 * the URL. That keeps a view linkable and makes the filters part of the React Query key, so
 * changing one starts a fresh infinite query rather than appending to the previous result set.
 */
export function RegisterToolbar({
  filters,
  onChange,
}: {
  filters: TxFilters;
  onChange: (patch: FilterPatch) => void;
}) {
  const now = new Date();
  const from = parts(filters.from, { month: 1, year: FIRST_YEAR });
  const to = parts(filters.to, { month: now.getMonth() + 1, year: now.getFullYear() });

  // The search box is uncontrolled between keystrokes so typing stays responsive; it syncs to the
  // URL on a debounce. Re-seeded when the URL changes from elsewhere (back button, a preset click).
  const [term, setTerm] = useState(filters.search ?? '');
  useEffect(() => setTerm(filters.search ?? ''), [filters.search]);

  // `onChange` is a fresh closure every render. Held in a ref so the debounce effect below can
  // call the current one without listing it as a dependency, which would restart the timer on
  // every render and mean the search never fires.
  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;

  useEffect(() => {
    const current = filters.search ?? '';
    if (term === current) {
      return;
    }
    const id = setTimeout(() => latestOnChange.current({ search: term || undefined }), 300);
    return () => clearTimeout(id);
  }, [term, filters.search]);

  const activeLabel =
    filters.window === 'custom'
      ? `${MONTHS[from.month - 1].slice(0, 3)} ${from.year} – ${MONTHS[to.month - 1].slice(0, 3)} ${to.year}`
      : WINDOW_LABELS[filters.window];

  const setRange = (next: { from?: string; to?: string }) =>
    onChange({
      window: 'custom',
      from: next.from ?? filters.from ?? monthStart(from.year, from.month),
      to: next.to ?? filters.to ?? monthEnd(to.year, to.month),
    });

  return (
    <div className="flex items-center gap-2 pb-3">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1">
            {activeLabel}
            <ChevronDown className="size-4 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[26rem]">
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium">View Options</p>
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    size="sm"
                    variant={filters.window === preset ? 'default' : 'ghost'}
                    onClick={() =>
                      // Clearing from/to matters: a stale custom range would otherwise linger in the
                      // URL and reappear the next time the user opened the custom selects.
                      onChange({ window: preset, from: undefined, to: undefined })
                    }
                  >
                    {WINDOW_LABELS[preset]}
                  </Button>
                ))}
              </div>
            </div>

            <div
              className={cn(
                'flex items-center gap-2 text-sm',
                filters.window !== 'custom' && 'opacity-60',
              )}
            >
              <span className="w-10 shrink-0">From:</span>
              <MonthYear
                month={from.month}
                year={from.year}
                onChange={(m, y) => setRange({ from: monthStart(y, m) })}
              />
            </div>
            <div
              className={cn(
                'flex items-center gap-2 text-sm',
                filters.window !== 'custom' && 'opacity-60',
              )}
            >
              <span className="w-10 shrink-0">To:</span>
              <MonthYear
                month={to.month}
                year={to.year}
                onChange={(m, y) => setRange({ to: monthEnd(y, m) })}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <div className="relative ms-auto w-64">
        <Search className="text-muted-foreground absolute start-2 top-1/2 size-4 -translate-y-1/2" />
        <Input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          // Escape clears, matching the browser-native search-input convention.
          onKeyDown={(event) => event.key === 'Escape' && setTerm('')}
          placeholder="Search description or payee"
          className="ps-8 pe-8"
        />
        {term && (
          <button
            type="button"
            // Clears `term`, and the debounce effect drops `search` from the URL from there — no
            // separate navigate call, so there's one code path for changing the search.
            onClick={() => setTerm('')}
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute end-2 top-1/2 -translate-y-1/2 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function MonthYear({
  month,
  year,
  onChange,
}: {
  month: number;
  year: number;
  onChange: (month: number, year: number) => void;
}) {
  return (
    <>
      <Select value={String(month)} onValueChange={(value) => onChange(Number(value), year)}>
        <SelectTrigger size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MONTHS.map((label, index) => (
            <SelectItem key={label} value={String(index + 1)}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(year)} onValueChange={(value) => onChange(month, Number(value))}>
        <SelectTrigger size="sm" className="w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {yearOptions().map((value) => (
            <SelectItem key={value} value={String(value)}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
