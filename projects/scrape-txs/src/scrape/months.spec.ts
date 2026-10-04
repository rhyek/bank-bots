import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultMonths, lastFullSuccessAt, monthsSince } from './months';

// Local-time constructors: the rule is about the calendar day where the service runs.
test('defaultMonths: through the 10th, the previous month is scraped too', () => {
  assert.deepEqual(defaultMonths(new Date(2026, 9, 10, 7, 0)), ['2026-09', '2026-10']);
});

test('defaultMonths: from the 11th, only the current month', () => {
  assert.deepEqual(defaultMonths(new Date(2026, 9, 11, 7, 0)), ['2026-10']);
});

test('defaultMonths: in January the previous month is last December', () => {
  assert.deepEqual(defaultMonths(new Date(2027, 0, 3, 7, 0)), ['2026-12', '2027-01']);
});

// --- monthsSince: how far back a run with no months requested reaches -------------------------

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 7, 0);

test('monthsSince: with no successful scrape on record, the default rule applies', () => {
  assert.deepEqual(monthsSince(null, at(2026, 10, 4)).months, ['2026-09', '2026-10']);
  assert.deepEqual(monthsSince(null, at(2026, 10, 20)).months, ['2026-10']);
});

test('monthsSince: a daily scrape behaves like the default rule', () => {
  assert.deepEqual(monthsSince(at(2026, 10, 19), at(2026, 10, 20)).months, ['2026-10']);
  assert.deepEqual(monthsSince(at(2026, 11, 3), at(2026, 11, 4)).months, ['2026-10', '2026-11']);
});

test('monthsSince: a gap across a month end reaches back to the month it started in', () => {
  // Last good run Oct 28, next run Nov 11: Oct 29-31 must still be scraped.
  assert.deepEqual(monthsSince(at(2026, 10, 28), at(2026, 11, 11)).months, ['2026-10', '2026-11']);
});

test('monthsSince: a gap of a few months covers every month in between', () => {
  assert.deepEqual(monthsSince(at(2026, 7, 20), at(2026, 10, 15)), {
    months: ['2026-07', '2026-08', '2026-09', '2026-10'],
    skipped: [],
  });
});

test('monthsSince: reaches no further than the current month and the three before it', () => {
  // BAC's statement picker only offers recent months; asking for an older one fails the run, and a
  // run that fails never moves the last success forward. The older months are reported instead.
  assert.deepEqual(monthsSince(at(2026, 3, 20), at(2026, 10, 15)), {
    months: ['2026-07', '2026-08', '2026-09', '2026-10'],
    skipped: ['2026-03', '2026-04', '2026-05', '2026-06'],
  });
});

test('monthsSince: looks 10 days behind the last success, for transactions that post late', () => {
  // Last success Nov 3 saw October, but an Oct 31 charge can still post until about Nov 10.
  assert.deepEqual(monthsSince(at(2026, 11, 3), at(2026, 11, 20)).months, ['2026-10', '2026-11']);
  assert.deepEqual(monthsSince(at(2026, 11, 12), at(2026, 11, 20)).months, ['2026-11']);
});

test('monthsSince: crosses a year boundary', () => {
  assert.deepEqual(monthsSince(at(2026, 12, 28), at(2027, 1, 15)).months, ['2026-12', '2027-01']);
});

// --- lastFullSuccessAt: which stored run counts as "the bank was fully scraped then" -----------

const stored = (startedAt: Date, months: string[]) => ({
  startedAt: startedAt.toISOString(),
  months,
});

test('lastFullSuccessAt: the newest run that covered the month it ran in', () => {
  const runs = [
    stored(at(2026, 10, 3), ['2026-03']), // a manual backfill of March: says nothing about October
    stored(at(2026, 10, 1), ['2026-09', '2026-10']),
    stored(at(2026, 9, 30), ['2026-09']),
  ];
  assert.deepEqual(lastFullSuccessAt(runs), at(2026, 10, 1));
});

test('lastFullSuccessAt: null when no run covered its own month', () => {
  assert.equal(lastFullSuccessAt([stored(at(2026, 10, 3), ['2026-03'])]), null);
  assert.equal(lastFullSuccessAt([]), null);
});
