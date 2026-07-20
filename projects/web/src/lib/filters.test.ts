import { describe, expect, it } from 'vitest';
import { registerSearchSchema } from './filters';

// `validateSearch` runs on every navigation, including URLs a human typed or that were bookmarked
// against an older version of the app. It must never throw — a bad field falls back to a default.
describe('registerSearchSchema', () => {
  it('defaults to this month when the URL carries no window', () => {
    expect(registerSearchSchema({})).toEqual({
      window: 'this-month',
      from: undefined,
      to: undefined,
      search: undefined,
      unmatchedOnly: false,
    });
  });

  it('keeps a recognized window', () => {
    expect(registerSearchSchema({ window: 'last-3-months' }).window).toBe('last-3-months');
  });

  it('falls back rather than throwing on an unrecognized window', () => {
    expect(registerSearchSchema({ window: 'last-tuesday' }).window).toBe('this-month');
    expect(registerSearchSchema({ window: 42 }).window).toBe('this-month');
  });

  it('rejects malformed dates so garbage never reaches Postgres as a date literal', () => {
    const parsed = registerSearchSchema({ window: 'custom', from: 'yesterday', to: '2026-01-31' });
    expect(parsed.from).toBeUndefined();
    expect(parsed.to).toBe('2026-01-31');
  });

  it('trims the search term and treats whitespace-only as absent', () => {
    expect(registerSearchSchema({ search: '  uber  ' }).search).toBe('uber');
    expect(registerSearchSchema({ search: '   ' }).search).toBeUndefined();
  });

  it('accepts unmatchedOnly as a boolean or the string the URL actually carries', () => {
    expect(registerSearchSchema({ unmatchedOnly: true }).unmatchedOnly).toBe(true);
    expect(registerSearchSchema({ unmatchedOnly: 'true' }).unmatchedOnly).toBe(true);
    expect(registerSearchSchema({ unmatchedOnly: 'false' }).unmatchedOnly).toBe(false);
    expect(registerSearchSchema({}).unmatchedOnly).toBe(false);
  });
});
