const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/**
 * Whether `code` is a real ISO 3166-1 alpha-2 country code — not merely two capital letters.
 *
 * The codes come from agents and from the trailing field of bank descriptions, where two capitals
 * are just as often the tail of a word. Intl knows the actual list, so nothing is hard-coded here.
 * "ZZ" is its "Unknown Region" placeholder and is not a country.
 */
export function isCountryCode(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && code !== 'ZZ' && regionNames.of(code) !== undefined;
}

/** "Costa Rica" for "CR"; the code itself when it is not a country. */
export function countryName(code: string): string {
  return (isCountryCode(code) && regionNames.of(code)) || code;
}
