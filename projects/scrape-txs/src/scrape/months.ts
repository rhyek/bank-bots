import dayjs from 'dayjs';

/**
 * The months a scrape covers when none are asked for: the current month, plus the previous one
 * through the 10th, to catch transactions that post late.
 */
export function defaultMonths(now: Date): string[] {
  const today = dayjs(now);
  const months = [today.format('YYYY-MM')];
  if (today.date() <= 10) {
    months.unshift(today.subtract(1, 'month').format('YYYY-MM'));
  }
  return months;
}

// A transaction can post up to about this long after its date. It is why the previous month is
// still scraped early in a new one, and why a gap is measured from a little before the last success.
const LATE_POSTING_DAYS = 10;

// How far back a run reaches on its own: the current month and the three before it. BAC's statement
// picker only offers recent months (July was still there on October 1st, 2026), and a run that asks
// for a month the bank no longer offers fails — which would leave the last success where it was and
// make every later run ask for the same month again.
const MAX_AUTOMATIC_MONTHS = 4;

/**
 * The months a run covers when none are asked for, given when the bank was last fully scraped:
 * every month from 10 days before that success through the current one, and never fewer than
 * `defaultMonths`. With a scrape every day this is the default rule; after a gap it reaches back
 * to where the gap began, so the days between the last success and a month end are not lost.
 *
 * The reach is capped. Months older than the cap come back as `skipped`: they are not scraped, and
 * the owner is told to backfill them by asking for them explicitly.
 */
export function monthsSince(
  lastFullSuccess: Date | null,
  now: Date,
): { months: string[]; skipped: string[] } {
  const fallback = defaultMonths(now);
  if (!lastFullSuccess) {
    return { months: fallback, skipped: [] };
  }
  const reach = dayjs(lastFullSuccess).subtract(LATE_POSTING_DAYS, 'day').format('YYYY-MM');
  const start = reach < fallback[0]! ? reach : fallback[0]!;
  const end = dayjs(now).format('YYYY-MM');
  const all: string[] = [];
  for (let m = dayjs(`${start}-01`); m.format('YYYY-MM') <= end; m = m.add(1, 'month')) {
    all.push(m.format('YYYY-MM'));
  }
  const cut = Math.max(0, all.length - MAX_AUTOMATIC_MONTHS);
  return { months: all.slice(cut), skipped: all.slice(0, cut) };
}

/**
 * When the bank was last fully scraped, from its successful whole-bank runs (newest first). A run
 * only counts if it covered the month it ran in: a backfill of March run in October says nothing
 * about October.
 */
export function lastFullSuccessAt(runs: { startedAt: string; months: string[] }[]): Date | null {
  const run = runs.find((r) => r.months.includes(dayjs(r.startedAt).format('YYYY-MM')));
  return run ? new Date(run.startedAt) : null;
}
