import { isCountryCode } from '~/owner-location/country';

/** The place a bank description names, when it has one of the two fixed-width shapes that do. */
export type PlaceField = { shape: 'city'; value: string } | { shape: 'country'; value: string };

/**
 * Read the place field off a bank description.
 *
 *   30 chars = 25-char merchant field + 5-char city      "LA TORRE ZONA 14         GUATE"
 *   25 chars = 22-char merchant field + " " + country    "UBER *TRIP HELP.UBER.C NL"
 *
 * The last five characters of a 30-character line are a city only some of the time: in the 2026
 * history they are as often a phone number ("866-7"), a URL ("WWW.A"), a reference ("40020") or
 * punctuation ("A   ."). Anything with a digit or punctuation in it is therefore not a place.
 *
 * What survives is still not always one: an online brand's own name or home town lands in the same
 * field ("OPENA", "ANTHR", "TORON"). Those cannot be told apart by shape, so the reader — the day
 * location resolver, the payee location matcher — is told to expect them.
 */
export function placeField(description: string): PlaceField | null {
  if (description.length === 30) {
    const tail = description.slice(25);
    const letters = tail.replace(/ /g, '');
    return /^[\p{L} ]{5}$/u.test(tail) && letters.length >= 3
      ? { shape: 'city', value: tail.trim() }
      : null;
  }
  if (description.length === 25) {
    const match = /^.{22} ([A-Z]{2})$/.exec(description);
    return match && isCountryCode(match[1]!) ? { shape: 'country', value: match[1]! } : null;
  }
  return null;
}
