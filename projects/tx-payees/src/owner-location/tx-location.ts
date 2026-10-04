import { addDays, daysBetween, windowDates } from '~/location/location-day';
import { countryName } from '~/owner-location/country';
import type { ResolvedDay } from '~/owner-location/resolved-day';

/** A transaction's date and the nine days before it: a charge posts days after the purchase. */
export const WINDOW_DAYS = 10;
/** How long a purchase typically takes to post. Measured at 2-3 days in the 2026 history. */
export const POSTING_LAG_DAYS = 2;

/** Which lookup rule decided a transaction's location. */
export type LocationRule =
  'single-country' | 'description-country' | 'payee-country' | 'posting-lag' | 'none';

/** Where the owner was when a purchase happened: `matcher_result.data` of a `location` row. */
export interface TxLocation {
  /** The day the purchase is taken to have happened on. */
  purchaseDate: string | null;
  rule: LocationRule;
  country: string | null;
  location: string | null;
  /** True when every day of the window is resolved for good, so this will not change. */
  final: boolean;
}

/** The part of a payee that bears on where its purchases happened. */
export interface PayeePlace {
  locationKind: string | null;
  country: string | null;
}

/** The candidate nearest to `target`; a tie goes to the earlier day, since purchases precede posting. */
function nearest(days: ResolvedDay[], target: string): ResolvedDay | undefined {
  return [...days].sort(
    (a, b) =>
      Math.abs(daysBetween(target, a.date)) - Math.abs(daysBetween(target, b.date)) ||
      a.date.localeCompare(b.date),
  )[0];
}

/**
 * Pick the day a transaction's purchase happened on, and so where the owner was. No AI: the days
 * are already resolved, and this only chooses among them.
 *
 * The bank's date is the posting date, so the purchase lies somewhere in the ten days ending on it.
 *
 * 1. One country in the whole window (the usual case): that country, with the place of the day
 *    two days before posting, or of the nearest day that has one.
 * 2. Several countries, and the payee is a physical business (`local` or `chain`), so the owner
 *    had to be at the branch: the latest day on which the owner was in the branch's country. A shop
 *    in Costa Rica that posts after the owner flew home was still paid in Costa Rica. The branch's
 *    country is the one the transaction's own description names (`describedCountry`), and failing
 *    that the payee's. The description comes first because it is about this purchase: a global
 *    chain's payee has no country at all, and a payee's country only says where its branches
 *    have been so far.
 * 3. Otherwise: two days before posting, the typical lag, or the nearest resolved day to that.
 * 4. No day in the window places the owner anywhere: null.
 *
 * `describedCountry` is what the description's place field stands for, when it has one. It is
 * ignored unless the payee is a physical business: on an online charge the same field holds a
 * billing office or the merchant's home town.
 */
export function locateTx(
  txDate: string,
  payee: PayeePlace | null,
  days: ReadonlyMap<string, ResolvedDay>,
  describedCountry: string | null = null,
): TxLocation {
  const window = windowDates(txDate, WINDOW_DAYS);
  const resolved = window.flatMap((date) => days.get(date) ?? []);
  const final = resolved.length === window.length && resolved.every((day) => !day.provisional);
  const placed = resolved.filter((day) => day.country !== null);
  if (placed.length === 0) {
    return { purchaseDate: null, rule: 'none', country: null, location: null, final };
  }

  const target = addDays(txDate, -POSTING_LAG_DAYS);
  const pick = (day: ResolvedDay, rule: LocationRule): TxLocation => ({
    purchaseDate: day.date,
    rule,
    country: day.country,
    location: day.location,
    final,
  });

  const countries = new Set(placed.map((day) => day.country));
  if (countries.size === 1) {
    const withPlace = placed.filter((day) => day.location !== null);
    return pick(nearest(withPlace.length > 0 ? withPlace : placed, target)!, 'single-country');
  }

  if (payee?.locationKind === 'local' || payee?.locationKind === 'chain') {
    const lastDayIn = (country: string) => placed.filter((day) => day.country === country).at(-1)!;
    if (describedCountry && countries.has(describedCountry)) {
      return pick(lastDayIn(describedCountry), 'description-country');
    }
    if (payee.country && countries.has(payee.country)) {
      return pick(lastDayIn(payee.country), 'payee-country');
    }
  }

  return pick(nearest(placed, target)!, 'posting-lag');
}

/** Two lookups that would write the same thing. */
export function sameTxLocation(a: TxLocation, b: TxLocation): boolean {
  return (
    a.purchaseDate === b.purchaseDate &&
    a.rule === b.rule &&
    a.country === b.country &&
    a.location === b.location &&
    a.final === b.final
  );
}

function describeDay(day: ResolvedDay | undefined): string {
  if (!day || day.country === null) {
    return 'not known';
  }
  const place = day.location
    ? `${day.location}, ${countryName(day.country)}`
    : countryName(day.country);
  const how = day.basis === 'observed' ? 'observed' : `inferred, ${day.confidence} confidence`;
  return `${place} (${day.country}) — ${how}`;
}

/**
 * The "where the owner was" block of the payee matcher's prompt, built from resolved days.
 * Consecutive days with the same answer collapse into one line, so ten days at home is one line.
 *
 * `estimate` is the lookup made before any payee is known. It is null, and so is the whole block,
 * when no day in the window places the owner anywhere.
 */
export function formatOwnerWindow(
  txDate: string,
  days: ReadonlyMap<string, ResolvedDay>,
  estimate: TxLocation,
): string | null {
  if (estimate.country === null) {
    return null;
  }
  const runs: { from: string; to: string; text: string }[] = [];
  for (const date of windowDates(txDate, WINDOW_DAYS)) {
    const text = describeDay(days.get(date));
    const last = runs.at(-1);
    if (last?.text === text) {
      last.to = date;
    } else {
      runs.push({ from: date, to: date, text });
    }
  }
  const width = '0000-00-00 to 0000-00-00'.length;
  const place = estimate.location
    ? `${estimate.location}, ${countryName(estimate.country)}`
    : countryName(estimate.country);
  return [
    'where the owner was on this date and the days before it (calendar days in UTC-6):',
    ...runs.map((run) => {
      const range = run.from === run.to ? run.from : `${run.from} to ${run.to}`;
      return `  ${range.padEnd(width)}  ${run.text}`;
    }),
    `best estimate for the day of purchase (${estimate.purchaseDate}): ${place} (${estimate.country})`,
  ].join('\n');
}
