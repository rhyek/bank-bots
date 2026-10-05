import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ResolvedDay } from '~/owner-location/resolved-day';
import { formatOwnerWindow, locateTx, sameTxLocation } from '~/owner-location/tx-location';

type DaySpec = [date: string, country: string | null, location?: string | null, final?: boolean];

function days(...specs: DaySpec[]): Map<string, ResolvedDay> {
  return new Map(
    specs.map(([date, country, location = null, final = true]) => [
      date,
      {
        date,
        country,
        location,
        basis: country ? 'observed' : 'unknown',
        confidence: 'high',
        provisional: !final,
        resolvedAt: '2026-10-01T00:00:00Z',
      } satisfies ResolvedDay,
    ]),
  );
}

/** `from`..`to` inclusive, all in one place. */
function stretch(from: string, to: string, country: string | null, location?: string): DaySpec[] {
  const out: DaySpec[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); ; d = new Date(d.getTime() + 86_400_000)) {
    const date = d.toISOString().slice(0, 10);
    out.push([date, country, location]);
    if (date === to) {
      return out;
    }
  }
}

test('locateTx rule 1: one country in the window takes the place of two days before posting', () => {
  const window = days(
    ...stretch('2026-07-01', '2026-07-07', 'GT', 'Guatemala City'),
    ['2026-07-08', 'GT', 'Antigua Guatemala'],
    ['2026-07-09', 'GT', 'Guatemala City'],
    ['2026-07-10', 'GT', 'Guatemala City'],
  );
  assert.deepEqual(locateTx('2026-07-10', null, window), {
    purchaseDate: '2026-07-08',
    rule: 'single-country',
    country: 'GT',
    location: 'Antigua Guatemala',
    final: true,
  });
});

test('locateTx rule 1: falls to the nearest day that has a place, the earlier one on a tie', () => {
  const window = days(
    ...stretch('2026-07-01', '2026-07-06', 'GT'),
    ['2026-07-07', 'GT', 'Escuintla'],
    ['2026-07-08', 'GT', null],
    ['2026-07-09', 'GT', 'Guatemala City'],
    ['2026-07-10', 'GT', null],
  );
  const out = locateTx('2026-07-10', null, window);
  assert.equal(out.purchaseDate, '2026-07-07');
  assert.equal(out.location, 'Escuintla');
});

test('locateTx rule 1: unknown days do not count as a second country', () => {
  const window = days(
    ...stretch('2026-07-01', '2026-07-08', null),
    ['2026-07-09', 'GT', 'Guatemala City'],
    ['2026-07-10', null],
  );
  const out = locateTx('2026-07-10', null, window);
  assert.equal(out.rule, 'single-country');
  assert.equal(out.purchaseDate, '2026-07-09');
});

// IMPERIAL STORE: an airport shop in Costa Rica whose charge posted on 2026-09-23, three days after
// the owner flew home.
const trip = days(
  ...stretch('2026-09-14', '2026-09-19', 'CR', 'Tamarindo, Guanacaste'),
  ['2026-09-20', 'CR', 'Alajuela'],
  ...stretch('2026-09-21', '2026-09-23', 'GT', 'Guatemala City'),
);

test('locateTx rule 2: a local payee abroad is placed on the last day the owner was there', () => {
  assert.deepEqual(locateTx('2026-09-23', { locationKind: 'local', country: 'CR' }, trip), {
    purchaseDate: '2026-09-20',
    rule: 'payee-country',
    country: 'CR',
    location: 'Alajuela',
    final: true,
  });
});

test('locateTx rule 2: a chain counts as well, and picks the latest day in its country', () => {
  const out = locateTx('2026-09-23', { locationKind: 'chain', country: 'GT' }, trip);
  assert.equal(out.rule, 'payee-country');
  assert.equal(out.purchaseDate, '2026-09-23');
});

test("locateTx rule 2: the country the description names comes before the payee's", () => {
  // A global chain: no country of its own, so the branch's town decides.
  assert.deepEqual(locateTx('2026-09-23', { locationKind: 'chain', country: null }, trip, 'CR'), {
    purchaseDate: '2026-09-20',
    rule: 'description-country',
    country: 'CR',
    location: 'Alajuela',
    final: true,
  });
  // A payee filed in one country, used at a branch in the other.
  const abroad = locateTx('2026-09-23', { locationKind: 'chain', country: 'GT' }, trip, 'CR');
  assert.equal(abroad.rule, 'description-country');
  assert.equal(abroad.country, 'CR');
});

test("locateTx rule 2: a described country the owner was not in falls back to the payee's", () => {
  const out = locateTx('2026-09-23', { locationKind: 'local', country: 'CR' }, trip, 'PA');
  assert.equal(out.rule, 'payee-country');
  assert.equal(out.country, 'CR');
});

test('locateTx rule 2: a chain with no country and no described one goes by the posting lag', () => {
  const out = locateTx('2026-09-23', { locationKind: 'chain', country: null }, trip, null);
  assert.equal(out.rule, 'posting-lag');
});

test('locateTx: the description is ignored unless the payee is a physical business', () => {
  for (const payee of [
    { locationKind: 'remote', country: 'US' },
    { locationKind: null, country: null },
    null,
  ]) {
    assert.equal(locateTx('2026-09-23', payee, trip, 'CR').rule, 'posting-lag');
  }
  // And with one country in the window there is nothing for it to decide.
  const home = days(...stretch('2026-07-01', '2026-07-10', 'GT', 'Guatemala City'));
  const out = locateTx('2026-07-10', { locationKind: 'chain', country: null }, home, 'CR');
  assert.equal(out.rule, 'single-country');
});

test("locateTx: at a local payee the place is the payee's own, not the day's", () => {
  const airport = 'Juan Santamaría airport, Alajuela';
  const imperial = { locationKind: 'local', country: 'CR', location: airport };
  // Around a trip, by the description's country...
  assert.deepEqual(locateTx('2026-09-23', imperial, trip, 'CR'), {
    purchaseDate: '2026-09-20',
    rule: 'description-country',
    country: 'CR',
    location: airport,
    final: true,
  });
  // ...and at home, where the day only says "Guatemala City".
  const home = days(...stretch('2026-07-01', '2026-07-10', 'GT', 'Guatemala City'));
  const cafe = { locationKind: 'local', country: 'GT', location: 'Zona 14, Guatemala City' };
  assert.equal(locateTx('2026-07-10', cafe, home).location, 'Zona 14, Guatemala City');
});

test("locateTx: the payee's place is not used when the owner was in another country, or for a chain", () => {
  // A local payee in Panama, paid while the owner was in Guatemala and Costa Rica: not in person.
  const elsewhere = { locationKind: 'local', country: 'PA', location: 'Casco Viejo, Panama City' };
  assert.equal(locateTx('2026-09-23', elsewhere, trip).location, 'Guatemala City');
  // A chain has branches, not a place; a stray location on it is ignored.
  const chain = { locationKind: 'chain', country: 'GT', location: 'Zona 10' };
  assert.equal(locateTx('2026-09-23', chain, trip).location, 'Guatemala City');
});

test('locateTx rule 3: a remote payee, or none, goes by the posting lag', () => {
  for (const payee of [{ locationKind: 'remote', country: 'US' }, null]) {
    assert.deepEqual(locateTx('2026-09-23', payee, trip), {
      purchaseDate: '2026-09-21',
      rule: 'posting-lag',
      country: 'GT',
      location: 'Guatemala City',
      final: true,
    });
  }
});

test('locateTx rule 3: a physical payee in a country the owner was not in goes by the lag too', () => {
  const out = locateTx('2026-09-23', { locationKind: 'local', country: 'PA' }, trip);
  assert.equal(out.rule, 'posting-lag');
  assert.equal(out.country, 'GT');
});

test('locateTx rule 3: uses the nearest placed day when two days before posting is unknown', () => {
  const window = days(
    ...stretch('2026-09-14', '2026-09-19', 'CR', 'San José'),
    ['2026-09-20', null],
    ['2026-09-21', null],
    ['2026-09-22', 'GT', 'Guatemala City'],
    ['2026-09-23', 'GT', 'Guatemala City'],
  );
  assert.equal(locateTx('2026-09-23', null, window).purchaseDate, '2026-09-22');
});

test('locateTx rule 4: a window that places the owner nowhere is null', () => {
  const unknown = days(...stretch('2026-07-01', '2026-07-10', null));
  assert.deepEqual(locateTx('2026-07-10', null, unknown), {
    purchaseDate: null,
    rule: 'none',
    country: null,
    location: null,
    final: true,
  });
  assert.equal(locateTx('2026-07-10', null, new Map()).final, false);
});

test('locateTx: final only when every day of the window is resolved for good', () => {
  const provisional = days(...stretch('2026-07-01', '2026-07-09', 'GT', 'Guatemala City'), [
    '2026-07-10',
    'GT',
    'Guatemala City',
    false,
  ]);
  assert.equal(locateTx('2026-07-10', null, provisional).final, false);

  const missing = days(...stretch('2026-07-02', '2026-07-10', 'GT', 'Guatemala City'));
  assert.equal(locateTx('2026-07-10', null, missing).final, false);
});

test('sameTxLocation: any difference, including finality, is a new result', () => {
  const a = locateTx('2026-09-23', null, trip);
  assert.equal(sameTxLocation(a, { ...a }), true);
  assert.equal(sameTxLocation(a, { ...a, final: false }), false);
  assert.equal(sameTxLocation(a, { ...a, location: 'Mixco' }), false);
});

test('formatOwnerWindow: collapses runs, names the estimate, and says how each was decided', () => {
  const window = new Map(trip);
  window.set('2026-09-22', { ...window.get('2026-09-22')!, basis: 'inferred', confidence: 'low' });
  const text = formatOwnerWindow('2026-09-23', window, locateTx('2026-09-23', null, window))!;
  const lines = text.split('\n');
  assert.match(
    lines[1]!,
    /2026-09-14 to 2026-09-19 {2}Tamarindo, Guanacaste, Costa Rica \(CR\) — observed/,
  );
  assert.match(lines[2]!, /2026-09-20 +Alajuela, Costa Rica \(CR\) — observed/);
  assert.match(
    lines[4]!,
    /2026-09-22 +Guatemala City, Guatemala \(GT\) — inferred, low confidence/,
  );
  assert.match(
    lines.at(-1)!,
    /best estimate for the day of purchase \(2026-09-21\): Guatemala City, Guatemala \(GT\)/,
  );
});

test('formatOwnerWindow: no block at all when nothing places the owner', () => {
  const unknown = days(...stretch('2026-07-01', '2026-07-10', null));
  assert.equal(
    formatOwnerWindow('2026-07-10', unknown, locateTx('2026-07-10', null, unknown)),
    null,
  );
});
