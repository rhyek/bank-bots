/**
 * Every "this must never reach the logs" rule, in one file, so the request middleware and the
 * axios error serializer can't drift apart.
 *
 * Header names and URL parameter names are matched by PATTERN, not by an enumerated list, because
 * every vendor spells its credential differently — `x-api-key`, `x-shopify-access-token`,
 * `x-hub-signature`, `?access_token=`. A name list is a list you will forget to update on the day
 * it matters; a pattern catches the next one for free.
 *
 * Both rules match NAMES only. They never inspect values, so they can't be fooled by, or slowed
 * down by, a large payload.
 */

/** Default for `strip.headers`. */
export const DEFAULT_SENSITIVE_HEADERS =
  /authorization|cookie|token|secret|password|credential|signature|api[-_]?key|access[-_]?key/i;

/**
 * Default for `strip.url`. Deliberately narrower than the header rule: a query parameter is far
 * more likely to be an innocent word (`?key=sortOrder`, `?code=US`), and redacting a parameter
 * that wasn't a secret makes debugging confusing. Only unambiguous credential words are here —
 * bare `key` and `code` are left out on purpose.
 */
export const DEFAULT_SENSITIVE_URL_PARAMS =
  /access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|^token$|secret|password|signature|credential/i;

export const REDACTED = '[redacted]';

// Matches nothing. `new RegExp('')` would match EVERYTHING, so an explicit `[]` — meaning "redact
// none of these" — needs this rather than an empty alternation.
const MATCH_NOTHING = /(?!)/;

/**
 * Entries are OR'd: a string matches that exact name, a RegExp matches anywhere in the name.
 * Always case-insensitive — HTTP header names are, and query keys are close enough in practice.
 */
function compileMatcher(entries: readonly (RegExp | string)[]): RegExp {
  if (entries.length === 0) {
    return MATCH_NOTHING;
  }
  const alternatives = entries.map((entry) =>
    typeof entry === 'string'
      ? // Anchored + escaped: a plain name is an EXACT match, and a name containing regex
        // metacharacters can't corrupt the combined pattern.
        `^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
      : // A RegExp contributes its source; `g`/`y` are dropped by rebuilding with a fixed flag
        // set, because those flags make .test() stateful via lastIndex — a shared instance would
        // otherwise match every OTHER call.
        entry.source,
  );
  return new RegExp(alternatives.join('|'), 'i');
}

let headerPattern: RegExp = DEFAULT_SENSITIVE_HEADERS;
let urlParamPattern: RegExp = DEFAULT_SENSITIVE_URL_PARAMS;

/** Set by `configureRootLogger` from `forRoot({ strip: { headers } })`. Replaces the default. */
export function setSensitiveHeaders(entries: readonly (RegExp | string)[]): void {
  headerPattern = compileMatcher(entries);
}

/** Set by `configureRootLogger` from `forRoot({ strip: { url } })`. Replaces the default. */
export function setSensitiveUrlParams(entries: readonly (RegExp | string)[]): void {
  urlParamPattern = compileMatcher(entries);
}

export function isSensitiveHeader(name: string): boolean {
  return headerPattern.test(name);
}

export function isSensitiveUrlParam(name: string): boolean {
  return urlParamPattern.test(name);
}

/**
 * A copy of `headers` with sensitive VALUES replaced by `[redacted]` — the key is kept on
 * purpose. "An Authorization header was sent, and it was wrong" is a different bug from "no
 * Authorization header was sent at all", and deleting the key makes those two look identical.
 *
 * Returns undefined for a non-object so callers can pass whatever an HTTP client handed them.
 */
export function redactHeaders(headers: unknown): Record<string, unknown> | undefined {
  if (typeof headers !== 'object' || headers === null) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  // Axios's AxiosHeaders keeps values as own enumerable props, so this covers both it and a
  // plain Node headers object.
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === 'function') {
      continue;
    }
    out[key] = isSensitiveHeader(key) ? REDACTED : value;
  }
  return out;
}

/**
 * `url` with the values of sensitive query parameters replaced, path and parameter order intact:
 * `/cb?code=x&access_token=SECRET` → `/cb?code=x&access_token=[redacted]`.
 *
 * A credential in the query string is the one leak `strip.headers` and `strip.json` can't reach —
 * it arrives as part of the request line, so it lands in `req.url` (and, in a normal deployment,
 * in the reverse proxy's access log too, which this cannot help with).
 *
 * Hand-parsed rather than via `new URL()` on purpose: URL round-tripping re-encodes and reorders
 * pieces, so the logged URL would stop matching what the client actually sent. Here every
 * untouched parameter is passed through byte-for-byte.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) {
    return url;
  }
  const queryStart = url.indexOf('?');
  if (queryStart === -1) {
    return url;
  }
  const path = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1);

  const redacted = query
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      // A valueless flag (`?debug`) has nothing to redact.
      if (equals === -1) {
        return pair;
      }
      const rawKey = pair.slice(0, equals);
      let key: string;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // Malformed percent-encoding — match on the raw form rather than throwing mid-request.
        key = rawKey;
      }
      return isSensitiveUrlParam(key) ? `${rawKey}=${REDACTED}` : pair;
    })
    .join('&');

  return `${path}?${redacted}`;
}
