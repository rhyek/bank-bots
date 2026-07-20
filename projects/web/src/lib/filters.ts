export type TimeWindow =
  'this-month' | 'last-3-months' | 'this-year' | 'last-year' | 'all' | 'custom';

export type TxFilters = {
  accountId?: string;
  window: TimeWindow;
  /** Inclusive 'YYYY-MM-DD'. Only meaningful when window === 'custom'. */
  from?: string;
  to?: string;
  search?: string;
  unmatchedOnly?: boolean;
};

const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * Resolve a window to an inclusive `[from, to]` date range, or null for "all dates".
 * `today` is injectable so this is testable without freezing the clock.
 */
export function resolveWindow(
  filters: TxFilters,
  today = new Date(),
): { from: string; to: string } | null {
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  // Day 0 of month `m` (1-based) is the last day of month `m` — `new Date` rolls it back.
  const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate();

  switch (filters.window) {
    case 'all':
      return null;
    case 'this-month':
      return { from: iso(year, month, 1), to: iso(year, month, lastDay(year, month)) };
    case 'last-3-months': {
      // Inclusive of the current month, so "latest 3 months" spans this month and the two before.
      const start = new Date(year, today.getMonth() - 2, 1);
      return {
        from: iso(start.getFullYear(), start.getMonth() + 1, 1),
        to: iso(year, month, lastDay(year, month)),
      };
    }
    case 'this-year':
      return { from: iso(year, 1, 1), to: iso(year, 12, 31) };
    case 'last-year':
      return { from: iso(year - 1, 1, 1), to: iso(year - 1, 12, 31) };
    case 'custom':
      return { from: filters.from ?? iso(year, 1, 1), to: filters.to ?? iso(year, 12, 31) };
  }
}

export const TIME_WINDOWS: TimeWindow[] = [
  'this-month',
  'last-3-months',
  'this-year',
  'last-year',
  'all',
  'custom',
];

/** Labels for the preset buttons, mirroring YNAB's View Options. `custom` has no button. */
export const WINDOW_LABELS: Record<Exclude<TimeWindow, 'custom'>, string> = {
  'this-month': 'This Month',
  'last-3-months': 'Latest 3 Months',
  'this-year': 'This Year',
  'last-year': 'Last Year',
  all: 'All Dates',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses the register's URL search params.
 *
 * Hand-written rather than zod: it is five fields, and `validateSearch` must never throw on a
 * hand-edited or stale URL — every field falls back to a default instead. `accountId` is
 * deliberately absent; it comes from the route path (`/accounts/$accountId`), so an account's URL
 * stays clean.
 */
export function registerSearchSchema(search: Record<string, unknown>): TxFilters {
  const window = TIME_WINDOWS.includes(search.window as TimeWindow)
    ? (search.window as TimeWindow)
    : 'this-month';

  // Only trust well-formed dates — a garbage `from` would otherwise reach Postgres as a date literal.
  const date = (value: unknown) =>
    typeof value === 'string' && ISO_DATE.test(value) ? value : undefined;

  const searchTerm = typeof search.search === 'string' ? search.search.trim() : '';

  return {
    window,
    from: date(search.from),
    to: date(search.to),
    search: searchTerm || undefined,
    unmatchedOnly: search.unmatchedOnly === true || search.unmatchedOnly === 'true',
  };
}

/** First day of a month, and the last — the two ends the From/To month+year selects produce. */
export function monthStart(year: number, month: number) {
  return iso(year, month, 1);
}

export function monthEnd(year: number, month: number) {
  return iso(year, month, new Date(year, month, 0).getDate());
}
