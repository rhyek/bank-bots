/**
 * Pure shaping of the tracker's location history — no I/O. `LocationService` fetches and caches;
 * this turns the points of a day into a summary, and a summary into the line the day location
 * resolver reads.
 */

/** The two fields of a Dawarich point this feature reads. `country` on a point is always null. */
export interface RawPoint {
  country_name?: string | null;
  city?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  /** The import a point came from; null for points the live tracker recorded itself. */
  topic?: string | null;
}

export interface Place {
  country: string | null;
  city: string | null;
  points: number;
}

/** One calendar day (UTC-6): every distinct place seen, busiest first. */
export interface LocationDay {
  date: string;
  pointCount: number;
  places: Place[];
  /**
   * True when nothing was actually observed that day: every point comes from the Google Timeline
   * import and sits on one coordinate. The import fills a day it has no data for with 96 copies of
   * the last place it knew, and that filler has been wrong for weeks at a stretch — in 2026 it kept
   * the owner in San José through January and early May while their card was in daily in-person
   * use in Guatemala City.
   */
  assumed: boolean;
}

const MAX_CITIES = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function summarizeDay(date: string, points: RawPoint[]): LocationDay {
  const byPlace = new Map<string, Place>();
  for (const p of points) {
    const country = p.country_name || null;
    const city = p.city || null;
    const key = JSON.stringify([country, city]);
    const place = byPlace.get(key) ?? { country, city, points: 0 };
    place.points += 1;
    byPlace.set(key, place);
  }
  const coordinates = new Set(points.map((p) => `${p.latitude},${p.longitude}`));
  return {
    date,
    pointCount: points.length,
    // Stable sort: ties keep first-seen order.
    places: [...byPlace.values()].sort((a, b) => b.points - a.points),
    assumed:
      points.length > 0 &&
      coordinates.size === 1 &&
      points.every((p) => p.topic?.startsWith('Google Maps') ?? false),
  };
}

/** `date` and the `days - 1` days before it, oldest first. */
export function windowDates(date: string, days: number): string[] {
  const end = toMs(date);
  return Array.from({ length: days }, (_, i) =>
    new Date(end - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * Whether a cached day can be trusted for good.
 *
 * The phone uploads late, so a recent day may still gain points, and an empty day may yet be filled
 * in however old it is. Only a day that has points and is more than two days old is final.
 */
export function isSettled(day: LocationDay, today: string): boolean {
  return day.pointCount > 0 && (toMs(today) - toMs(day.date)) / DAY_MS > 2;
}

/** `date` moved by `days` calendar days (negative = earlier). */
export function addDays(date: string, days: number): string {
  return new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

/**
 * One tracker day as the day location resolver reads it: how the day was recorded, then each
 * country seen with its busiest cities. A day in two countries is a travel day.
 *
 *   observed  Costa Rica (San José, Río Segundo) + Guatemala (Guatemala City)
 *   assumed   Costa Rica (San José)
 *   missing
 */
export function describeTrackerDay(day: LocationDay): string {
  if (day.pointCount === 0) {
    return 'missing';
  }
  const byCountry = new Map<string, string[]>();
  for (const place of day.places) {
    if (!place.country) {
      continue;
    }
    const cities = byCountry.get(place.country) ?? [];
    if (place.city && cities.length < MAX_CITIES) {
      cities.push(place.city);
    }
    byCountry.set(place.country, cities);
  }
  const kind = day.assumed ? 'assumed ' : 'observed';
  if (byCountry.size === 0) {
    return `${kind}  place not identified`;
  }
  const where = [...byCountry.entries()]
    .map(([country, cities]) => (cities.length > 0 ? `${country} (${cities.join(', ')})` : country))
    .join(' + ');
  return `${kind}  ${where}`;
}
