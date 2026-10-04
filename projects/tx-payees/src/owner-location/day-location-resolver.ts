import { z } from 'zod';
import { isCountryCode } from '~/owner-location/country';
import type { Basis, Confidence } from '~/owner-location/resolved-day';

/**
 * What the resolver returns for a run of days.
 *
 * Shallow on purpose, like the payee matcher's answer: the SDK re-prompts on a schema mismatch and
 * gives up after a retry limit, and nesting is the documented way to hit it.
 */
export const DayAnswers = z.object({
  days: z.array(
    z.object({
      date: z.string().describe('YYYY-MM-DD: one of the days asked for'),
      country: z
        .string()
        .nullable()
        .describe('ISO 3166-1 alpha-2, uppercase; null only when basis is "unknown"'),
      location: z.string().nullable().describe('City or area, e.g. "Guatemala City"; or null'),
      basis: z.enum(['observed', 'inferred', 'unknown']),
      confidence: z.enum(['high', 'medium', 'low']),
      reason: z.string().describe('One sentence: the evidence that decided this day'),
    }),
  ),
});

export interface DayAnswer {
  date: string;
  country: string | null;
  location: string | null;
  basis: Basis;
  confidence: Confidence;
  reason: string;
}

export interface DayRun {
  /** The days to resolve: consecutive, oldest first. */
  dates: string[];
  /** The evidence block from buildDayEvidence. */
  evidence: string;
}

/**
 * The day location resolver, as OwnerLocationService sees it.
 *
 * An abstract class rather than an interface so it doubles as a Nest injection token; tests
 * substitute a stub, so the service is exercised with no agent, no network and no API token.
 */
export abstract class DayLocationResolver {
  /** One answer per requested day. May throw; may also answer badly, which the caller checks. */
  abstract resolve(run: DayRun): Promise<DayAnswer[]>;
}

/**
 * Hold a run's answers to the request: every day asked for exactly once, nothing else, and a real
 * country on every day that claims one.
 *
 * Anything else throws, and the caller writes nothing — a run is all or nothing, so a half-answered
 * run can never leave some of its days resolved from evidence the others were not judged against.
 */
export function checkDayAnswers(dates: string[], answers: DayAnswer[]): DayAnswer[] {
  const byDate = new Map<string, DayAnswer>();
  for (const answer of answers) {
    if (!dates.includes(answer.date)) {
      throw new Error(`answered for ${answer.date}, which was not asked for`);
    }
    if (byDate.has(answer.date)) {
      throw new Error(`answered for ${answer.date} twice`);
    }
    const country = answer.country?.trim().toUpperCase() || null;
    if (country !== null && !isCountryCode(country)) {
      throw new Error(`${answer.date}: "${answer.country}" is not an ISO 3166-1 alpha-2 code`);
    }
    if (country !== null && answer.basis === 'unknown') {
      throw new Error(`${answer.date}: basis is "unknown" but a country (${country}) was given`);
    }
    byDate.set(answer.date, {
      ...answer,
      country,
      // No country means nothing is known, whatever else the answer said.
      location: country === null ? null : answer.location?.trim() || null,
      basis: country === null ? 'unknown' : answer.basis,
    });
  }
  const omitted = dates.filter((date) => !byDate.has(date));
  if (omitted.length > 0) {
    throw new Error(`no answer for ${omitted.join(', ')}`);
  }
  return dates.map((date) => byDate.get(date)!);
}
