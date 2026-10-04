export type Basis = 'observed' | 'inferred' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';

/** Where the owner was on one calendar day (UTC-6): a row of `owner_day_location`. */
export interface ResolvedDay {
  date: string;
  /** ISO 3166-1 alpha-2; null when nothing places the owner that day. */
  country: string | null;
  location: string | null;
  basis: Basis;
  confidence: Confidence;
  /** A provisional day may still change and is resolved again; a final one is not. */
  provisional: boolean;
  /** When it was last resolved (ISO timestamp). */
  resolvedAt: string;
}

/** A freshly resolved day on its way into the store. */
export interface ResolvedDayWrite extends Omit<ResolvedDay, 'resolvedAt'> {
  /** The evidence the resolver was shown for this day and its one-line reason. */
  data: { reason: string; tracker: string; charges: string[] };
}
