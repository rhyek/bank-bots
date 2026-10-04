import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocationDay } from '~/location/location-day';
import {
  buildDayEvidence,
  consecutiveRuns,
  evidenceRange,
  type Charge,
} from '~/owner-location/day-evidence';

const observed = (date: string, country: string, city: string): LocationDay => ({
  date,
  pointCount: 12,
  places: [{ country, city, points: 12 }],
  assumed: false,
});
const assumed = (date: string, country: string, city: string): LocationDay => ({
  ...observed(date, country, city),
  pointCount: 96,
  assumed: true,
});
const missing = (date: string): LocationDay => ({
  date,
  pointCount: 0,
  places: [],
  assumed: false,
});

const charge = (date: string, description: string, extra: Partial<Charge> = {}): Charge => ({
  date,
  description,
  amountCents: -1182,
  payeeName: null,
  payeeKind: null,
  payeeCountry: null,
  ...extra,
});

const LA_TORRE = 'LA TORRE ZONA 14         GUATE';
const IMPERIAL = 'IMPERIAL STORE           ALAJU';

test('evidenceRange: three tracker days either side, charges to five days after, clamped to today', () => {
  const dates = ['2026-01-10', '2026-01-11', '2026-01-12'];
  const range = evidenceRange(dates, '2026-10-04');
  assert.equal(range.trackerDates[0], '2026-01-07');
  assert.equal(range.trackerDates.at(-1), '2026-01-15');
  assert.equal(range.trackerDates.length, 9);
  assert.equal(range.chargesFrom, '2026-01-10');
  assert.equal(range.chargesTo, '2026-01-17');

  const recent = evidenceRange(['2026-10-03', '2026-10-04'], '2026-10-04');
  assert.equal(recent.trackerDates.at(-1), '2026-10-04');
  assert.equal(recent.chargesTo, '2026-10-04');
});

test('buildDayEvidence: labels each tracker day observed, assumed or missing', () => {
  const { text } = buildDayEvidence(
    ['2026-05-03', '2026-05-04'],
    [
      observed('2026-05-02', 'Costa Rica', 'San José'),
      assumed('2026-05-03', 'Costa Rica', 'San José'),
      missing('2026-05-04'),
    ],
    [],
  );
  assert.match(text, /Days to resolve: 2026-05-03 to 2026-05-04 \(2 days\)/);
  assert.match(text, /2026-05-02 {2}observed {2}Costa Rica \(San José\)/);
  assert.match(text, /2026-05-03 {2}assumed {3}Costa Rica \(San José\)/);
  assert.match(text, /2026-05-04 {2}missing/);
  assert.match(text, /under their POSTING date:\n {2}none/);
});

test('buildDayEvidence: a travel day names both countries', () => {
  const travel: LocationDay = {
    date: '2026-09-20',
    pointCount: 13,
    places: [
      { country: 'Costa Rica', city: 'San José', points: 7 },
      { country: 'Guatemala', city: 'Guatemala City', points: 6 },
    ],
    assumed: false,
  };
  const { text } = buildDayEvidence(['2026-09-20'], [travel], []);
  assert.match(text, /observed {2}Costa Rica \(San José\) \+ Guatemala \(Guatemala City\)/);
});

test('buildDayEvidence: lists only debits whose description names a place', () => {
  const { text } = buildDayEvidence(
    ['2026-09-20'],
    [missing('2026-09-20')],
    [
      charge('2026-09-23', IMPERIAL),
      charge('2026-09-21', LA_TORRE, {
        payeeName: 'La Torre',
        payeeKind: 'chain',
        payeeCountry: 'GT',
      }),
      charge('2026-09-22', 'UBER *TRIP HELP.UBER.C NL', { payeeName: 'Uber', payeeKind: 'remote' }),
      // Not places: a phone number, a URL, a line with no fixed-width shape, and a refund.
      charge('2026-09-21', 'OPENAI *CHATGPT SUBSCR   866-7'),
      charge('2026-09-21', 'AMAZON RETA* 5O1VJ7GB0   WWW.A'),
      charge('2026-09-21', 'TF: ACH INMEDIATO 9004228'),
      charge('2026-09-21', 'CEMACO PRADERA           GUATE', { amountCents: 4500 }),
    ],
  );
  const listed = text.split('POSTING date:\n')[1]!.split('\n');
  assert.deepEqual(listed, [
    `  2026-09-21  "${LA_TORRE}"  city field "GUATE"  11.82 USD  payee: La Torre (chain GT)`,
    '  2026-09-22  "UBER *TRIP HELP.UBER.C NL"  country NL  11.82 USD  payee: Uber (remote)',
    `  2026-09-23  "${IMPERIAL}"  city field "ALAJU"  11.82 USD  payee: not identified`,
  ]);
});

test('buildDayEvidence: says so when the tracker could not be read', () => {
  const { text, perDay } = buildDayEvidence(['2026-09-20'], null, [charge('2026-09-21', LA_TORRE)]);
  assert.match(text, /Location tracker: unavailable/);
  assert.doesNotMatch(text, /one line per day/);
  assert.equal(perDay.get('2026-09-20')!.tracker, 'unavailable');
});

test("buildDayEvidence: shows the already-resolved days either side, never the run's own", () => {
  const resolved = (date: string, country: string | null, location: string | null) => ({
    date,
    country,
    location,
    basis: country ? ('inferred' as const) : ('unknown' as const),
    confidence: 'high' as const,
    provisional: false,
    resolvedAt: '2026-10-01T00:00:00Z',
  });
  const { text } = buildDayEvidence(
    ['2026-01-29', '2026-01-30'],
    null,
    [],
    [
      resolved('2026-01-28', 'GT', 'Guatemala City'),
      resolved('2026-01-27', null, null),
      // A provisional answer for a day of the run itself is what is being redone, not context.
      resolved('2026-01-29', 'CR', 'San José'),
    ],
  );
  const block = text.split('already resolved, from evidence you are not shown:\n')[1]!;
  assert.deepEqual(block.split('\n').slice(0, 3), [
    '  2026-01-27  not known',
    '  2026-01-28  Guatemala City, Guatemala (GT), inferred, high confidence',
    '',
  ]);

  assert.doesNotMatch(buildDayEvidence(['2026-01-29'], null, []).text, /already resolved/);
});

test('buildDayEvidence: each day keeps its own tracker line and the charges that could be its', () => {
  const { perDay } = buildDayEvidence(
    ['2026-09-18', '2026-09-19'],
    [observed('2026-09-18', 'Costa Rica', 'Tempate'), missing('2026-09-19')],
    [
      charge('2026-09-18', LA_TORRE),
      charge('2026-09-23', IMPERIAL),
      charge('2026-09-24', IMPERIAL),
    ],
  );
  assert.equal(perDay.get('2026-09-18')!.tracker, 'observed  Costa Rica (Tempate)');
  // Sep 18 reaches to the 23rd; Sep 19 to the 24th, and not back to the 18th.
  assert.equal(perDay.get('2026-09-18')!.charges.length, 2);
  assert.deepEqual(
    perDay.get('2026-09-19')!.charges.map((line) => line.slice(0, 10)),
    ['2026-09-23', '2026-09-24'],
  );
});

test('consecutiveRuns: breaks at a gap and at the maximum length', () => {
  const dates = Array.from({ length: 16 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
  const runs = consecutiveRuns([...dates, '2026-01-20', '2026-01-21'], 14);
  assert.deepEqual(
    runs.map((run) => [run[0], run.at(-1), run.length]),
    [
      ['2026-01-01', '2026-01-14', 14],
      ['2026-01-15', '2026-01-16', 2],
      ['2026-01-20', '2026-01-21', 2],
    ],
  );
});
