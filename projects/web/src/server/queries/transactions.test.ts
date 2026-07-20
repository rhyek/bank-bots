import { describe, expect, it } from 'vitest';
import { bankTx, count, db } from '@bank-bots/db';
import { resolveWindow } from '~/lib/filters';
import { listTransactionsQuery } from './transactions';

const ALL = { window: 'all' as const };

describe('resolveWindow', () => {
  const today = new Date(2026, 6, 19); // 2026-07-19, local

  it('spans the current calendar month', () => {
    expect(resolveWindow({ window: 'this-month' }, today)).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('spans the previous calendar month', () => {
    expect(resolveWindow({ window: 'last-month' }, today)).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    });
  });

  it('rolls back to the previous December when today is in January', () => {
    // The bug this guards: computing `month - 1` arithmetically yields month 0 in January.
    expect(resolveWindow({ window: 'last-month' }, new Date(2026, 0, 15))).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('ends last month on the 28th in a non-leap February', () => {
    expect(resolveWindow({ window: 'last-month' }, new Date(2026, 2, 10))).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('includes the current month in the latest 3 months', () => {
    expect(resolveWindow({ window: 'last-3-months' }, today)).toEqual({
      from: '2026-05-01',
      to: '2026-07-31',
    });
  });

  it('returns null for all dates', () => {
    expect(resolveWindow(ALL, today)).toBeNull();
  });
});

describe('listTransactionsQuery', () => {
  it('returns rows newest first', async () => {
    const page = await listTransactionsQuery({ filters: ALL, cursor: null, pageSize: 50 });

    expect(page.rows.length).toBe(50);
    for (let i = 1; i < page.rows.length; i++) {
      expect(page.rows[i - 1].date >= page.rows[i].date).toBe(true);
    }
  });

  it('pages the whole set exactly once, with no duplicates or gaps at page boundaries', async () => {
    // The real test of a keyset cursor: walk every page and prove the union is the full set.
    // The expected size is read from the database rather than hardcoded, so a scrape landing new
    // rows doesn't turn this into a false failure — the property under test is "every row exactly
    // once", not any particular row count.
    const [{ total }] = await db.select({ total: count() }).from(bankTx);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: Awaited<ReturnType<typeof listTransactionsQuery>> = await listTransactionsQuery({
        filters: ALL,
        cursor,
        pageSize: 500,
      });
      for (const row of page.rows) {
        expect(seen.has(row.id)).toBe(false); // no duplicate across a boundary
        seen.add(row.id);
      }
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(100); // guard against an infinite loop on a broken cursor
    } while (cursor);

    expect(seen.size).toBe(total);
  });

  it('signals the end of pagination with a null cursor', async () => {
    const page = await listTransactionsQuery({
      filters: { window: 'custom', from: '2022-01-01', to: '2022-01-02' },
      cursor: null,
      pageSize: 500,
    });
    expect(page.nextCursor).toBeNull();
  });

  it('filters to a single account', async () => {
    const all = await listTransactionsQuery({ filters: ALL, cursor: null, pageSize: 1 });
    const accountId = all.rows[0].accountId;
    const page = await listTransactionsQuery({
      filters: { ...ALL, accountId },
      cursor: null,
      pageSize: 100,
    });
    expect(page.rows.every((r) => r.accountId === accountId)).toBe(true);
  });

  it('filters to unmatched rows only', async () => {
    const page = await listTransactionsQuery({
      filters: { ...ALL, unmatchedOnly: true },
      cursor: null,
      pageSize: 100,
    });
    expect(page.rows.every((r) => r.payeeId === null)).toBe(true);
  });

  it('searches description and payee name case-insensitively', async () => {
    // Take a real description from the newest page so the search is guaranteed to have a hit,
    // and lowercase it to prove the match is case-insensitive. Trim it too: the query itself trims
    // the search term (see `filters.search?.trim()` in listTransactionsQuery), so a 12-char slice
    // that lands on a space — e.g. "NETFLIX.COM " out of "NETFLIX.COM  US" — would otherwise assert
    // on a trailing space the query never searched for, failing on the clean "NETFLIX.COM" rows.
    const [seed] = (await listTransactionsQuery({ filters: ALL, cursor: null, pageSize: 1 })).rows;
    const term = seed.description.slice(0, 12).trim().toLowerCase();

    const page = await listTransactionsQuery({
      filters: { ...ALL, search: term },
      cursor: null,
      pageSize: 100,
    });

    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      const haystack = [row.description, row.payeeName]
        .filter((value) => value !== null)
        .join('\n')
        .toLowerCase();
      expect(haystack).toContain(term);
    }
  });

  it('restricts rows to the requested date range', async () => {
    const page = await listTransactionsQuery({
      filters: { window: 'custom', from: '2026-01-01', to: '2026-01-31' },
      cursor: null,
      pageSize: 200,
    });

    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      // `date` is a 'YYYY-MM-DD' string, so lexical comparison is chronological.
      expect(row.date >= '2026-01-01').toBe(true);
      expect(row.date <= '2026-01-31').toBe(true);
    }
  });
});
