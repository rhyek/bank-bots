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
