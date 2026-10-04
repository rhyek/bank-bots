import { addDays, describeTrackerDay, type LocationDay } from '~/location/location-day';
import { countryName } from '~/owner-location/country';
import { placeField } from '~/owner-location/place-field';
import type { ResolvedDay } from '~/owner-location/resolved-day';

/** How many days of tracker history are shown either side of the days being resolved. */
export const TRACKER_CONTEXT_DAYS = 3;
/** How far past the last day charges are shown: a purchase posts days after it happens. */
export const CHARGE_LAG_DAYS = 5;

/** A card charge as the evidence builder sees it. */
export interface Charge {
  date: string;
  description: string;
  amountCents: number;
  payeeName: string | null;
  payeeKind: string | null;
  payeeCountry: string | null;
}

export interface DayEvidence {
  /** The whole evidence block, as the resolver reads it. */
  text: string;
  /** What bears on each requested day on its own: kept with the day as its audit trail. */
  perDay: Map<string, { tracker: string; charges: string[] }>;
}

/**
 * The tracker days and charge dates a run of `dates` needs, both clamped to `today`. The tracker
 * days outside the run are also the neighbours whose earlier answers the resolver is shown.
 */
export function evidenceRange(
  dates: string[],
  today: string,
): { trackerDates: string[]; chargesFrom: string; chargesTo: string } {
  const first = dates[0]!;
  const last = dates.at(-1)!;
  const clamp = (date: string) => (date > today ? today : date);
  const trackerDates: string[] = [];
  const trackerTo = clamp(addDays(last, TRACKER_CONTEXT_DAYS));
  for (let d = addDays(first, -TRACKER_CONTEXT_DAYS); d <= trackerTo; d = addDays(d, 1)) {
    trackerDates.push(d);
  }
  return { trackerDates, chargesFrom: first, chargesTo: clamp(addDays(last, CHARGE_LAG_DAYS)) };
}

function chargeLine(charge: Charge): string | null {
  const place = placeField(charge.description);
  // Only debits: a refund or a deposit says nothing about where the owner was.
  if (!place || charge.amountCents >= 0) {
    return null;
  }
  const field = place.shape === 'city' ? `city field "${place.value}"` : `country ${place.value}`;
  const kind = [charge.payeeKind, charge.payeeCountry].filter(Boolean).join(' ');
  const payee = charge.payeeName
    ? `payee: ${charge.payeeName}${kind ? ` (${kind})` : ''}`
    : 'payee: not identified';
  const usd = (Math.abs(charge.amountCents) / 100).toFixed(2);
  return `${charge.date}  "${charge.description}"  ${field}  ${usd} USD  ${payee}`;
}

/**
 * Everything the day location resolver is shown for one run of days.
 *
 * `dates` are the days to resolve, consecutive and oldest first. `tracker` is the tracker's summary
 * of those days plus a few either side, or `null` when the tracker could not be read at all — which
 * is said outright, because "no data that day" and "could not ask" must not look alike. `charges`
 * may include any charge; only debits whose description names a place are listed.
 *
 * `neighbours` are days just outside the run that an earlier run already resolved. Each run is a
 * separate agent call and sees only its own slice of the charges, so without them a run that
 * starts the day after three weeks of card use in Guatemala City has only the tracker to go on for
 * where the owner was coming from — and before 2026-08 the tracker is exactly what cannot be
 * trusted.
 */
export function buildDayEvidence(
  dates: string[],
  tracker: LocationDay[] | null,
  charges: Charge[],
  neighbours: ResolvedDay[] = [],
): DayEvidence {
  const first = dates[0]!;
  const last = dates.at(-1)!;
  const trackerLine = new Map(
    (tracker ?? []).map((day) => [day.date, describeTrackerDay(day)] as const),
  );
  const lines = charges
    .map((charge) => ({ date: charge.date, line: chargeLine(charge) }))
    .filter((c): c is { date: string; line: string } => c.line !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const settled = neighbours
    .filter((day) => !dates.includes(day.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  const text = [
    `Days to resolve: ${first} to ${last} (${dates.length} day${dates.length === 1 ? '' : 's'}).`,
    '',
    ...(tracker
      ? [
          'Location tracker, one line per day:',
          ...tracker.map((day) => `  ${day.date}  ${trackerLine.get(day.date)}`),
        ]
      : [
          'Location tracker: unavailable. It could not be read, which says nothing about where the',
          'owner was. Decide from the charges alone.',
        ]),
    ...(settled.length > 0
      ? [
          '',
          'Days either side of these that were already resolved, from evidence you are not shown:',
          ...settled.map((day) => `  ${day.date}  ${describeResolved(day)}`),
        ]
      : []),
    '',
    'Card charges that name a place, under their POSTING date:',
    ...(lines.length > 0 ? lines.map((c) => `  ${c.line}`) : ['  none']),
  ].join('\n');

  return {
    text,
    perDay: new Map(
      dates.map((date) => [
        date,
        {
          tracker: trackerLine.get(date) ?? 'unavailable',
          charges: lines
            .filter((c) => c.date >= date && c.date <= addDays(date, CHARGE_LAG_DAYS))
            .map((c) => c.line),
        },
      ]),
    ),
  };
}

function describeResolved(day: ResolvedDay): string {
  if (day.country === null) {
    return 'not known';
  }
  const place = [day.location, countryName(day.country)].filter(Boolean).join(', ');
  return `${place} (${day.country}), ${day.basis}, ${day.confidence} confidence`;
}

/** Split sorted dates into runs of consecutive days, none longer than `max`. */
export function consecutiveRuns(dates: string[], max: number): string[][] {
  const runs: string[][] = [];
  for (const date of dates) {
    const run = runs.at(-1);
    if (run && run.length < max && addDays(run.at(-1)!, 1) === date) {
      run.push(date);
    } else {
      runs.push([date]);
    }
  }
  return runs;
}
