import { z } from 'zod';
import { isCountryCode } from '~/owner-location/country';

/** What a description's 5-character city field stands for. A row of `place_field`. */
export interface PlaceEntry {
  field: string;
  /** ISO 3166-1 alpha-2, or null when the field does not name a place. */
  country: string | null;
  /** The place spelled out, e.g. "Guatemala City". */
  place: string | null;
}

/** Shallow on purpose: see the payee matcher's Answer. */
export const PlaceAnswers = z.object({
  fields: z.array(
    z.object({
      field: z.string().describe('The field exactly as given'),
      country: z
        .string()
        .nullable()
        .describe('ISO 3166-1 alpha-2, uppercase; null when the field is not a place'),
      place: z.string().nullable().describe('The place spelled out, e.g. "Guatemala City"'),
    }),
  ),
});

export interface PlaceRequest {
  /** Each field with a few of the descriptions it was read from. */
  fields: { field: string; samples: string[] }[];
}

/**
 * Works out what city fields stand for. An abstract class so it doubles as a Nest injection token;
 * tests substitute a stub.
 */
export abstract class PlaceFieldResolver {
  abstract resolve(request: PlaceRequest): Promise<PlaceEntry[]>;
}

/**
 * Hold a batch of answers to the request: every field asked about exactly once, nothing else, and
 * a real country wherever one is claimed. Anything else throws and nothing is stored.
 */
export function checkPlaceAnswers(fields: string[], answers: PlaceEntry[]): PlaceEntry[] {
  const byField = new Map<string, PlaceEntry>();
  for (const answer of answers) {
    if (!fields.includes(answer.field)) {
      throw new Error(`answered for "${answer.field}", which was not asked about`);
    }
    if (byField.has(answer.field)) {
      throw new Error(`answered for "${answer.field}" twice`);
    }
    const country = answer.country?.trim().toUpperCase() || null;
    if (country !== null && !isCountryCode(country)) {
      throw new Error(`"${answer.field}": "${answer.country}" is not an ISO 3166-1 alpha-2 code`);
    }
    byField.set(answer.field, {
      field: answer.field,
      country,
      place: country === null ? null : answer.place?.trim() || null,
    });
  }
  const omitted = fields.filter((field) => !byField.has(field));
  if (omitted.length > 0) {
    throw new Error(`no answer for ${omitted.map((f) => `"${f}"`).join(', ')}`);
  }
  return fields.map((field) => byField.get(field)!);
}

/**
 * The place resolver's instructions.
 *
 * The field is the last five characters of a 30-character description. In the 2026 history a third
 * of them were not places at all; the ones with digits or punctuation are dropped before this
 * (place-field.ts), which leaves real towns and the names or home towns of online businesses.
 */
export const PLACE_SYSTEM_PROMPT = `
You read the "city" field of Central American bank statements. A card charge is described in 30
characters: a 25-character merchant name, then a 5-character city, cut off to fit. You are given
such fields, each with a few of the descriptions it came from, and you say which place each one is.

The card's owner lives in Guatemala City and has a second base in San José, Costa Rica, so most
fields are towns in Guatemala or Costa Rica, truncated:

  GUATE  Guatemala City, GT      ANTIG  Antigua Guatemala, GT    ESCUI  Escuintla, GT
  SAN J  San José, CR            ALAJU  Alajuela, CR             HERED  Heredia, CR

Others are towns elsewhere that the owner travelled to.

Some are not places the card was used in at all. An online business puts its own name, its web
address or its home town in the same five characters: "OPENA" on an OpenAI charge, "ANTHR" on an
Anthropic one. The merchant name in the samples tells you which kind you are looking at. For
those, and for any field you cannot place with confidence, answer null for both country and place.
A wrong country is worse than none: it moves purchases to a country the owner was not in.

Answer for every field you were given, exactly once, with the field spelled exactly as given.
`.trim();

export function buildPlacePrompt(request: PlaceRequest): string {
  return [
    'Which place is each of these city fields?',
    '',
    ...request.fields.flatMap(({ field, samples }) => [
      `field "${field}", seen in:`,
      ...samples.map((sample) => `  "${sample}"`),
    ]),
  ].join('\n');
}
