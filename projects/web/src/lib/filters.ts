export type TimeWindow =
  'this-month' | 'last-month' | 'last-3-months' | 'this-year' | 'last-year' | 'all' | 'custom';

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
    case 'last-month': {
      // Built via `new Date` rather than `month - 1` so January correctly rolls back to the
      // previous December instead of producing month 0.
      const start = new Date(year, today.getMonth() - 1, 1);
      const y = start.getFullYear();
      const m = start.getMonth() + 1;
      return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) };
    }
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
  'last-month',
  'last-3-months',
  'this-year',
  'last-year',
  'all',
  'custom',
];

/** Labels for the preset buttons, mirroring YNAB's View Options. `custom` has no button. */
export const WINDOW_LABELS: Record<Exclude<TimeWindow, 'custom'>, string> = {
  'this-month': 'This Month',
  'last-month': 'Last Month',
  'last-3-months': 'Latest 3 Months',
  'this-year': 'This Year',
  'last-year': 'Last Year',
  all: 'All Dates',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

/**
 * What the transactions routes read out of the URL: the filters, plus `highlight`.
 *
 * `highlight` is NOT a filter, and keeping it out of `TxFilters` is load-bearing: `TxFilters` is the
 * React Query key, so folding a view concern into it would throw away every loaded page and refetch
 * the list each time the highlighted row changed.
 */
export type TransactionsSearch = TxFilters & { highlight?: string };

/** 'YYYY-MM' for a date. The spending page's month lives in the URL in this form. */
export function currentMonth(today = new Date()): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' → the inclusive date range covering it. */
export function monthRange(month: string): { from: string; to: string } {
  const [year, index] = month.split('-').map(Number);
  return { from: monthStart(year, index), to: monthEnd(year, index) };
}

/**
 * Step a 'YYYY-MM' by whole months. Built through `new Date` rather than arithmetic on the month
 * number so December → January rolls the year over instead of producing month 13.
 */
export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number);
  return currentMonth(new Date(year, index - 1 + delta, 1));
}

/** 'YYYY-MM' → 'July 2026'. Day 1 is safe here — the range never crosses a DST boundary. */
export function formatMonth(month: string): string {
  const [year, index] = month.split('-').map(Number);
  return new Date(year, index - 1, 1).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
  });
}

/**
 * Parses the spending page's URL search params. Like `transactionsSearchSchema`, it never throws on
 * a hand-edited URL — a malformed month falls back to the current one.
 */
export function spendingSearchSchema(search: Record<string, unknown>): { month: string } {
  const month = search.month;
  return {
    month: typeof month === 'string' && ISO_MONTH.test(month) ? month : currentMonth(),
  };
}

/**
 * Parses the transactions pages' URL search params.
 *
 * Hand-written rather than zod: it is five fields, and `validateSearch` must never throw on a
 * hand-edited or stale URL — every field falls back to a default instead. `accountId` is
 * deliberately absent; it comes from the route path (`/accounts/$accountId`), so an account's URL
 * stays clean.
 */
export function transactionsSearchSchema(
  search: Record<string, unknown>,
  /** What an absent/invalid `window` falls back to. `/unmatched` overrides it to 'all', because
   *  that backlog spans every year and a current-month default would read as "nothing to do". */
  defaultWindow: TimeWindow = 'this-month',
): TransactionsSearch {
  const window = TIME_WINDOWS.includes(search.window as TimeWindow)
    ? (search.window as TimeWindow)
    : defaultWindow;

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
    highlight: typeof search.highlight === 'string' ? search.highlight : undefined,
  };
}

/** First day of a month, and the last — the two ends the From/To month+year selects produce. */
export function monthStart(year: number, month: number) {
  return iso(year, month, 1);
}

export function monthEnd(year: number, month: number) {
  return iso(year, month, new Date(year, month, 0).getDate());
}

/**
 * The search object a `<Link>` must supply when navigating to a transactions route.
 *
 * `validateSearch` would fill these in anyway, but TanStack Router requires the caller to provide
 * required search params at the type level, so links carry them explicitly.
 */
export const defaultSearch = (window: TimeWindow = 'this-month'): TxFilters => ({
  window,
  unmatchedOnly: false,
});
