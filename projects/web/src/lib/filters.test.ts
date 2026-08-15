import { describe, expect, it } from 'vitest';
import { transactionsSearchSchema } from './filters';

// `validateSearch` runs on every navigation, including URLs a human typed or that were bookmarked
// against an older version of the app. It must never throw — a bad field falls back to a default.
describe('transactionsSearchSchema', () => {
  it('defaults to this month when the URL carries no window', () => {
    expect(transactionsSearchSchema({})).toEqual({
      window: 'this-month',
      from: undefined,
      to: undefined,
      search: undefined,
      unmatchedOnly: false,
    });
  });

  it('keeps a recognized window', () => {
    expect(transactionsSearchSchema({ window: 'last-3-months' }).window).toBe('last-3-months');
  });

  it('falls back rather than throwing on an unrecognized window', () => {
    expect(transactionsSearchSchema({ window: 'last-tuesday' }).window).toBe('this-month');
    expect(transactionsSearchSchema({ window: 42 }).window).toBe('this-month');
  });

  it('rejects malformed dates so garbage never reaches Postgres as a date literal', () => {
    const parsed = transactionsSearchSchema({
      window: 'custom',
      from: 'yesterday',
      to: '2026-01-31',
    });
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBe('2026-01-31');
  });

  it('trims the search term and treats whitespace-only as absent', () => {
    expect(transactionsSearchSchema({ search: '  uber  ' }).search).toBe('uber');
    expect(transactionsSearchSchema({ search: '   ' }).search).toBeUndefined();
  });

  it('accepts unmatchedOnly as a boolean or the string the URL actually carries', () => {
    expect(transactionsSearchSchema({ unmatchedOnly: true }).unmatchedOnly).toBe(true);
    expect(transactionsSearchSchema({ unmatchedOnly: 'true' }).unmatchedOnly).toBe(true);
    expect(transactionsSearchSchema({ unmatchedOnly: 'false' }).unmatchedOnly).toBe(false);
    expect(transactionsSearchSchema({}).unmatchedOnly).toBe(false);
  });
});
