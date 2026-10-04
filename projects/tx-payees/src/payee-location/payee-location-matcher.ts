import { z } from 'zod';
import { isCountryCode } from '~/owner-location/country';

export type LocationKind = 'local' | 'chain' | 'remote' | 'unknown';

/**
 * What the payee location matcher returns. Shallow on purpose: see the payee matcher's Answer.
 */
export const PayeeLocationAnswer = z.object({
  kind: z
    .enum(['local', 'chain', 'remote', 'unknown'])
    .describe(
      'local = one physical place; chain = several branches, paid in person; remote = paid ' +
        'without going anywhere; unknown = cannot be determined',
    ),
  country: z
    .string()
    .nullable()
    .describe(
      'ISO 3166-1 alpha-2, uppercase. Where the place is, or the one country a chain is in, or ' +
        'where a remote company is based. Null for a chain found in many countries, and for unknown.',
    ),
  location: z
    .string()
    .nullable()
    .describe('The specific place, for a local payee only, e.g. "Zona 10, Guatemala City"'),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z.string().describe('How you decided, and what you ruled out. Kept as an audit trail.'),
});

export type PayeeLocationAnswer = z.infer<typeof PayeeLocationAnswer>;

/** Everything the matcher is told about one payee. */
export interface PayeeLocationInput {
  name: string;
  txCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Up to ten statement lines, most recent first, distinct descriptions before repeats. */
  samples: { date: string; description: string; amountCents: number }[];
  /** How the payee's transactions spread over the place fields of their descriptions. */
  placeFields: { field: string; count: number }[];
  /** The transaction that prompted the lookup, and where the owner was when it was bought. */
  trigger: {
    date: string;
    description: string;
    ownerCountry: string | null;
    ownerLocation: string | null;
  };
}

/**
 * The payee location matcher, as PayeeLocationService sees it.
 *
 * An abstract class so it doubles as a Nest injection token; tests substitute a stub.
 */
export abstract class PayeeLocationMatcher {
  abstract match(input: PayeeLocationInput): Promise<PayeeLocationAnswer>;
}

/**
 * Hold an answer to what each kind means, so `payee` never stores a contradiction.
 *
 * A local payee must come with a country and a place, and a country that is given must be a real
 * one; anything else throws, which is a failed run to be retried, not something to record. A chain
 * may go without a country — that is how a brand with branches in many countries is recorded — and
 * so may a remote payee whose company the agent could not place: the first backfill failed on two
 * of those on every attempt. What a kind does not use is dropped rather than failed on, since an
 * agent that names a head-office city for a chain has still answered the question.
 */
export function checkPayeeLocation(answer: PayeeLocationAnswer): PayeeLocationAnswer {
  if (answer.kind === 'unknown') {
    return { ...answer, country: null, location: null };
  }
  const country = answer.country?.trim().toUpperCase() || null;
  if (country !== null && !isCountryCode(country)) {
    throw new Error(`"${answer.country}" is not an ISO 3166-1 alpha-2 code`);
  }
  if (answer.kind !== 'local') {
    return { ...answer, country, location: null };
  }
  if (country === null) {
    throw new Error('kind "local" needs a country');
  }
  const location = answer.location?.trim() || null;
  if (location === null) {
    throw new Error('kind "local" needs a location');
  }
  return { ...answer, country, location };
}
