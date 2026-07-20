import { describe, expect, it } from 'vitest';
import { currentMonth, formatMonth, monthRange, shiftMonth } from '~/lib/filters';
import { listBucketTransactionsQuery, monthSummaryQuery } from './spending';

describe('month arithmetic', () => {
  it('derives the current month', () => {
    expect(currentMonth(new Date(2026, 6, 20))).toBe('2026-07');
  });

  it('pads single-digit months', () => {
    expect(currentMonth(new Date(2026, 0, 5))).toBe('2026-01');
  });

  it('spans a month inclusively, to its real last day', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2026-07')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('rolls the year over at both boundaries', () => {
    // The bug this guards: arithmetic on the month number yields month 0 or month 13.
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
    expect(shiftMonth('2026-07', -7)).toBe('2025-12');
  });

  it('formats a month for display', () => {
    expect(formatMonth('2026-07')).toBe('July 2026');
  });
});

/**
 * These run against the REAL database — this project has no test database. Every assertion here is
 * a read, so nothing is mutated. January 2026 is the fixture: its figures were verified by hand
 * against the raw table, and it is far enough in the past that a new scrape cannot change it.
 */
describe('monthSummaryQuery', () => {
  const JANUARY = '2026-01';

  it('reports inflow, outflow and left over for the month', async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });

    expect(summary.inflowCents).toBe(1118314);
    expect(summary.outflowCents).toBe(655696);
    expect(summary.netCents).toBe(462618);
  });

  it('left over is always inflow minus outflow', async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });
    expect(summary.netCents).toBe(summary.inflowCents - summary.outflowCents);
  });

  it("hides YNAB's internal group, so income does not appear as a spending row", async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });

    expect(summary.groups.map((group) => group.name)).not.toContain('Internal Master Category');
    // The income is not lost — it is the header's inflow.
    expect(summary.inflowCents).toBeGreaterThan(1000000);
  });

  it('groups every visible category', async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });

    expect(summary.groups.map((group) => [group.name, group.netCents])).toEqual([
      ['Fixed', -446458],
      ['Variable', -148424],
      ['Non-Monthly', -25749],
      ['Required Variable', -20581],
      ['Health', -14484],
      // Positive: a $100 refund landed in Quality of Life and nothing was spent from it. See the
      // refund test below — this is the "net, not gross" rule showing up in the fixture.
      ['Quality of Life', 10000],
    ]);

    // Every January transaction carries a category, which is what makes this month a clean fixture.
    expect(summary.uncategorized).toBeNull();
  });

  it('nets a refund against its own category instead of reporting it as income', async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });
    const qualityOfLife = summary.groups.find((group) => group.name === 'Quality of Life')!;

    expect(qualityOfLife.categories).toEqual([
      { id: expect.any(String), name: 'Vegas 2025', netCents: 10000, txCount: 1 },
    ]);

    // The same $100 is also in the header's gross inflow — the two are different questions, and
    // this is why the group totals cannot be expected to sum to outflow.
    const groupTotal = summary.groups.reduce((sum, group) => sum + group.netCents, 0);
    expect(groupTotal).toBe(-summary.outflowCents + 10000);
  });

  it('agrees with the underlying rows at every group', async () => {
    // The aggregate and the drill-down are separate queries over the same filters. This is the
    // cross-check that they cannot drift: every group's total must equal the rows behind it.
    const summary = await monthSummaryQuery({ month: JANUARY });

    for (const group of summary.groups) {
      const rows = await listBucketTransactionsQuery({
        month: JANUARY,
        bucket: { kind: 'group', groupId: group.id },
      });
      const rowTotal = rows.reduce((sum, row) => sum + row.amountCents, 0);
      expect({ name: group.name, total: rowTotal }).toEqual({
        name: group.name,
        total: group.netCents,
      });
    }
  });

  it('sorts groups and their categories by spend, biggest first', async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });

    const nets = summary.groups.map((group) => group.netCents);
    expect(nets).toEqual([...nets].sort((a, b) => a - b));

    for (const group of summary.groups) {
      const categoryNets = group.categories.map((item) => item.netCents);
      expect(categoryNets).toEqual([...categoryNets].sort((a, b) => a - b));
    }
  });

  it("carries a category's own net, not its gross spending", async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });
    const fixed = summary.groups.find((group) => group.name === 'Fixed');

    expect(fixed?.categories.find((item) => item.name === 'Rent')).toEqual({
      id: expect.any(String),
      name: 'Rent',
      netCents: -200000,
      txCount: 1,
    });

    // A group's total is exactly its categories' — nothing is dropped between the two levels.
    const categoryTotal = fixed!.categories.reduce((sum, item) => sum + item.netCents, 0);
    expect(categoryTotal).toBe(fixed!.netCents);
  });

  it('counts uncategorized transactions toward the totals', async () => {
    // May 2026 is the opposite fixture: it carries the large self-transfers that are still
    // uncategorized, so it proves the bucket exists AND that it reaches the header.
    const summary = await monthSummaryQuery({ month: '2026-05' });

    expect(summary.uncategorized).not.toBeNull();
    expect(summary.uncategorized!.txCount).toBeGreaterThan(0);

    const rows = await listBucketTransactionsQuery({
      month: '2026-05',
      bucket: { kind: 'uncategorized' },
    });
    const rowsNet = rows.reduce((sum, row) => sum + row.amountCents, 0);
    expect(rowsNet).toBe(summary.uncategorized!.netCents);
  });

  it('returns an empty month rather than throwing', async () => {
    const summary = await monthSummaryQuery({ month: '2019-01' });

    expect(summary).toMatchObject({
      inflowCents: 0,
      outflowCents: 0,
      netCents: 0,
      groups: [],
      uncategorized: null,
    });
  });
});

describe('listBucketTransactionsQuery', () => {
  const JANUARY = '2026-01';

  it('lists exactly the transactions behind a category figure', async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });
    const electricity = summary.groups
      .flatMap((group) => group.categories)
      .find((item) => item.name === 'Electricity')!;

    const rows = await listBucketTransactionsQuery({
      month: JANUARY,
      bucket: { kind: 'category', categoryId: electricity.id },
    });

    expect(rows).toHaveLength(electricity.txCount);
    expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(electricity.netCents);
    expect(rows[0].payeeName).toBe('Eegsa');
  });

  it('splits inflow from outflow by sign', async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });

    const inflow = await listBucketTransactionsQuery({
      month: JANUARY,
      bucket: { kind: 'inflow' },
    });
    const outflow = await listBucketTransactionsQuery({
      month: JANUARY,
      bucket: { kind: 'outflow' },
    });

    expect(inflow.every((row) => row.amountCents > 0)).toBe(true);
    expect(outflow.every((row) => row.amountCents < 0)).toBe(true);
    expect(inflow.reduce((sum, row) => sum + row.amountCents, 0)).toBe(summary.inflowCents);
    expect(outflow.reduce((sum, row) => sum + row.amountCents, 0)).toBe(-summary.outflowCents);
  });

  it('lists a whole group, matching that group total', async () => {
    const summary = await monthSummaryQuery({ month: JANUARY });
    const fixed = summary.groups.find((group) => group.name === 'Fixed')!;

    const rows = await listBucketTransactionsQuery({
      month: JANUARY,
      bucket: { kind: 'group', groupId: fixed.id },
    });

    expect(rows.reduce((sum, row) => sum + row.amountCents, 0)).toBe(fixed.netCents);
  });

  it('stays inside the month', async () => {
    const rows = await listBucketTransactionsQuery({ month: JANUARY, bucket: { kind: 'all' } });
    const range = monthRange(JANUARY);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.date >= range.from && row.date <= range.to)).toBe(true);
  });

  it('excludes transfers from every bucket', async () => {
    // No row carries transfer_bank_account_id today, so this asserts the filter is wired rather
    // than that it currently removes anything — it is what makes marking transfers later a
    // data-only fix.
    const rows = await listBucketTransactionsQuery({ month: JANUARY, bucket: { kind: 'all' } });
    expect(rows.every((row) => row.transferAccountLabel === null)).toBe(true);
  });
});
