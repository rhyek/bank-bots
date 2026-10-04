import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import type { LocationDay } from '~/location/location-day';
import type { LocationService } from '~/location/location.service';
import type { ReplicaDb } from '~/replica-db/replica-db.service';
import { addTx as addReplicaTx, makeReplica } from '~/testing/replica';
import {
  DayLocationResolver,
  type DayAnswer,
  type DayRun,
} from '~/owner-location/day-location-resolver';
import type { OwnerDayStore } from '~/owner-location/owner-day-store';
import { OwnerLocationService } from '~/owner-location/owner-location.service';
import type { PlaceFieldStore } from '~/owner-location/place-field-store';
import {
  PlaceFieldResolver,
  type PlaceEntry,
  type PlaceRequest,
} from '~/owner-location/place-resolver';
import type { ResolvedDay, ResolvedDayWrite } from '~/owner-location/resolved-day';

const NOW = '2026-10-04T18:00:00Z';

/** A resolver that answers every day it is asked about with one place, and records the requests. */
class StubResolver extends DayLocationResolver {
  runs: DayRun[] = [];
  answer: (run: DayRun) => DayAnswer[] = (run) =>
    run.dates.map((date) => ({
      date,
      country: 'GT',
      location: 'Guatemala City',
      basis: 'observed',
      confidence: 'high',
      reason: 'tracker',
    }));

  resolve(run: DayRun): Promise<DayAnswer[]> {
    this.runs.push(run);
    return Promise.resolve(this.answer(run));
  }
}

/** owner_day_location, in memory. `resolvedAt` is stamped from the injected clock. */
function fakeStore(clock: () => Date) {
  const rows = new Map<string, ResolvedDay & { data: ResolvedDayWrite['data'] }>();
  const store = {
    async get(dates: string[]) {
      return dates.flatMap((date) => rows.get(date) ?? []);
    },
    async save(days: ResolvedDayWrite[]) {
      for (const day of days) {
        rows.set(day.date, { ...day, resolvedAt: clock().toISOString() });
      }
    },
  } as unknown as OwnerDayStore;
  return { store, rows };
}

function fakeTracker() {
  const state = { down: false, asked: [] as string[][] };
  const tracker = {
    async days(dates: string[]): Promise<LocationDay[] | null> {
      state.asked.push(dates);
      return state.down
        ? null
        : dates.map((date) => ({
            date,
            pointCount: 5,
            places: [{ country: 'Guatemala', city: 'Guatemala City', points: 5 }],
            assumed: false,
          }));
    },
  } as unknown as LocationService;
  return { tracker, state };
}

/** Knows three towns and treats everything else as not a place. Records what it was asked. */
class StubPlaceResolver extends PlaceFieldResolver {
  requests: PlaceRequest[] = [];
  towns: Record<string, [string, string]> = {
    GUATE: ['GT', 'Guatemala City'],
    'SAN J': ['CR', 'San José'],
    ALAJU: ['CR', 'Alajuela'],
  };
  answer: (request: PlaceRequest) => PlaceEntry[] = (request) =>
    request.fields.map(({ field }) => ({
      field,
      country: this.towns[field]?.[0] ?? null,
      place: this.towns[field]?.[1] ?? null,
    }));

  resolve(request: PlaceRequest): Promise<PlaceEntry[]> {
    this.requests.push(request);
    return Promise.resolve(this.answer(request));
  }
}

/** place_field, in memory. */
function fakePlaceStore() {
  const rows = new Map<string, PlaceEntry & { samples: string[] }>();
  const store = {
    async all() {
      return [...rows.values()];
    },
    async save(entries: (PlaceEntry & { samples: string[] })[]) {
      for (const entry of entries) {
        rows.set(entry.field, entry);
      }
    },
  } as unknown as PlaceFieldStore;
  return { store, rows };
}

const addTx = (replica: ReplicaDb, date: string, description: string) =>
  addReplicaTx(replica, description, { date });

function setup() {
  let now = new Date(NOW);
  const clock = () => now;
  const resolver = new StubResolver();
  const { store, rows } = fakeStore(clock);
  const { tracker, state: trackerState } = fakeTracker();
  const replica = makeReplica();
  const placeResolver = new StubPlaceResolver();
  const { store: placeStore, rows: placeRows } = fakePlaceStore();
  const service = new OwnerLocationService(
    tracker,
    resolver,
    store,
    replica,
    new StructuredLoggerService(),
    placeResolver,
    placeStore,
  );
  service.now = clock;
  return {
    service,
    resolver,
    placeResolver,
    placeRows,
    rows,
    replica,
    trackerState,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

/** `from`..`to` inclusive. */
function range(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let d = Date.parse(`${from}T00:00:00Z`);
    d <= Date.parse(`${to}T00:00:00Z`);
    d += 86_400_000
  ) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.TX_LOCATION_ENABLED;
});
afterEach(() => {
  process.env = { ...saved };
});

test('ensureDays: resolves only the days that have no answer yet', async () => {
  const { service, resolver } = setup();
  await service.ensureDays(range('2026-09-01', '2026-09-05'));
  await service.ensureDays(range('2026-09-03', '2026-09-08'));

  assert.equal(resolver.runs.length, 2);
  assert.deepEqual(resolver.runs[1]!.dates, ['2026-09-06', '2026-09-07', '2026-09-08']);
});

test('ensureDays: one call per run of consecutive days, never more than 14 days each', async () => {
  const { service, resolver } = setup();
  await service.ensureDays([
    ...range('2026-01-01', '2026-01-30'),
    ...range('2026-03-01', '2026-03-02'),
  ]);

  assert.deepEqual(
    resolver.runs.map((run) => [run.dates[0], run.dates.at(-1), run.dates.length]),
    [
      ['2026-01-01', '2026-01-14', 14],
      ['2026-01-15', '2026-01-28', 14],
      ['2026-01-29', '2026-01-30', 2],
      ['2026-03-01', '2026-03-02', 2],
    ],
  );
});

test('ensureDays: a day is final at ten days old, provisional when younger', async () => {
  const { service, rows } = setup();
  // Today is 2026-10-04 in UTC-6.
  await service.ensureDays(['2026-09-23', '2026-09-24', '2026-09-25']);

  assert.equal(rows.get('2026-09-23')!.provisional, false);
  assert.equal(rows.get('2026-09-24')!.provisional, false);
  assert.equal(rows.get('2026-09-25')!.provisional, true);
});

test('ensureDays: a provisional day is resolved again once its answer is a day old', async () => {
  const { service, resolver, setNow } = setup();
  await service.ensureDays(range('2026-09-20', '2026-10-01'));
  assert.equal(resolver.runs.length, 1);

  setNow('2026-10-05T10:00:00Z');
  await service.ensureDays(range('2026-09-20', '2026-10-01'));
  assert.equal(resolver.runs.length, 1, 'within 24 hours nothing is asked again');

  setNow('2026-10-05T19:00:00Z');
  await service.ensureDays(range('2026-09-20', '2026-10-01'));
  // Sep 20-24 were final; only the provisional stretch goes back to the resolver.
  assert.deepEqual(resolver.runs[1]!.dates, range('2026-09-25', '2026-10-01'));
});

test('ensureDays: a day that has not happened yet is not resolved', async () => {
  const { service, resolver } = setup();
  await service.ensureDays(['2026-10-04', '2026-10-05', '2026-10-06']);
  assert.deepEqual(resolver.runs[0]!.dates, ['2026-10-04']);
});

test('ensureDays: an answer that omits a date is a failed run and writes nothing', async () => {
  const { service, resolver, rows } = setup();
  const complete = resolver.answer;
  resolver.answer = (run) => complete(run).slice(1);

  await service.ensureDays(range('2026-09-01', '2026-09-05'));
  assert.equal(rows.size, 0);

  // The failure is remembered: the same stretch is not asked for again until the reset.
  resolver.answer = complete;
  await service.ensureDays(range('2026-09-03', '2026-09-05'));
  assert.equal(resolver.runs.length, 1);

  service.resetFailures();
  await service.ensureDays(range('2026-09-01', '2026-09-05'));
  assert.equal(rows.size, 5);
});

test('ensureDays: a repeated date or an invalid country fails the run too', async () => {
  for (const spoil of [
    (answers: DayAnswer[]) => [...answers, answers[0]!],
    (answers: DayAnswer[]) => answers.map((a) => ({ ...a, country: 'Guatemala' })),
    (answers: DayAnswer[]) => answers.map((a) => ({ ...a, basis: 'unknown' as const })),
  ]) {
    const { service, resolver, rows } = setup();
    const complete = resolver.answer;
    resolver.answer = (run) => spoil(complete(run));
    await service.ensureDays(range('2026-09-01', '2026-09-03'));
    assert.equal(rows.size, 0);
  }
});

test('ensureDays: one failed run does not stop the others', async () => {
  const { service, resolver, rows } = setup();
  const complete = resolver.answer;
  resolver.answer = (run) => (run.dates[0] === '2026-01-01' ? [] : complete(run));

  await service.ensureDays(range('2026-01-01', '2026-01-20'));
  assert.equal(resolver.runs.length, 2);
  assert.deepEqual([...rows.keys()], range('2026-01-15', '2026-01-20'));
});

test('ensureDays: with the tracker down it resolves from charges alone, always provisionally', async () => {
  const { service, resolver, rows, trackerState } = setup();
  trackerState.down = true;
  await service.ensureDays(['2026-03-01', '2026-03-02']);

  assert.match(resolver.runs[0]!.evidence, /Location tracker: unavailable/);
  assert.equal(rows.get('2026-03-01')!.provisional, true, 'although it is months old');
});

test('ensureDays: shows the resolver the tracker either side and the charges that follow', async () => {
  const { service, resolver, replica, trackerState } = setup();
  addTx(replica, '2026-03-01', 'LA TORRE ZONA 14         GUATE');
  addTx(replica, '2026-03-07', 'IMPERIAL STORE           ALAJU');
  addTx(replica, '2026-03-08', 'CEMACO PRADERA           GUATE');
  addTx(replica, '2026-03-03', 'NETFLIX.COM              866-7');

  await service.ensureDays(['2026-03-01', '2026-03-02']);

  assert.deepEqual(trackerState.asked[0], range('2026-02-26', '2026-03-05'));
  const evidence = resolver.runs[0]!.evidence;
  assert.match(evidence, /2026-03-01 {2}"LA TORRE ZONA 14 {9}GUATE"/);
  assert.match(evidence, /2026-03-07 {2}"IMPERIAL STORE/);
  assert.doesNotMatch(evidence, /CEMACO/, 'posted more than five days after the run');
  assert.doesNotMatch(evidence, /NETFLIX/, 'its "city" is a phone number');
});

test('ensureDays: a later run is told what the run before it concluded', async () => {
  const { service, resolver } = setup();
  await service.ensureDays(range('2026-01-01', '2026-01-20'));

  assert.doesNotMatch(resolver.runs[0]!.evidence, /already resolved/);
  const second = resolver.runs[1]!.evidence;
  assert.match(second, /2026-01-12 {2}Guatemala City, Guatemala \(GT\), observed, high confidence/);
  assert.match(second, /2026-01-14 {2}Guatemala City/);
  assert.doesNotMatch(second, /2026-01-15 {2}Guatemala City, Guatemala \(GT\), observed/);
});

test("ensureDays: keeps each day's evidence and reason with the day", async () => {
  const { service, rows, replica } = setup();
  addTx(replica, '2026-03-02', 'LA TORRE ZONA 14         GUATE');
  await service.ensureDays(['2026-03-01']);

  const { data } = rows.get('2026-03-01')!;
  assert.equal(data.reason, 'tracker');
  assert.equal(data.tracker, 'observed  Guatemala (Guatemala City)');
  assert.equal(data.charges.length, 1);
});

test('locate: looks the transaction up among its resolved days', async () => {
  const { service } = setup();
  await service.ensureDays(range('2026-09-01', '2026-09-10'));
  assert.deepEqual(await service.locate({ date: '2026-09-10', description: LA_TORRE }, null), {
    purchaseDate: '2026-09-08',
    rule: 'single-country',
    country: 'GT',
    location: 'Guatemala City',
    final: true,
  });
});

const LA_TORRE = 'LA TORRE ZONA 14         GUATE';
const SUBWAY = 'SUBWAY AURORA II         GUATE';

test('ensurePlaces: asks once about each distinct city field, with samples, and never again', async () => {
  const { service, placeResolver, placeRows } = setup();
  await service.ensurePlaces([
    LA_TORRE,
    SUBWAY,
    'IMPERIAL STORE           ALAJU',
    'CLAUDE.AI SUBSCRIPTION   ANTHR',
    // No city field: a phone number, a trailing country code, a transfer.
    'OPENAI *CHATGPT SUBSCR   866-7',
    'UBER *TRIP HELP.UBER.C NL',
    'TF: ACH INMEDIATO 9004228',
  ]);

  assert.equal(placeResolver.requests.length, 1);
  assert.deepEqual(placeResolver.requests[0]!.fields, [
    { field: 'GUATE', samples: [LA_TORRE, SUBWAY] },
    { field: 'ALAJU', samples: ['IMPERIAL STORE           ALAJU'] },
    { field: 'ANTHR', samples: ['CLAUDE.AI SUBSCRIPTION   ANTHR'] },
  ]);
  assert.equal(placeRows.get('GUATE')!.country, 'GT');
  // "Not a place" is an answer too, and is not asked about again.
  assert.equal(placeRows.get('ANTHR')!.country, null);

  await service.ensurePlaces([LA_TORRE, 'CLAUDE.AI SUBSCRIPTION   ANTHR']);
  assert.equal(placeResolver.requests.length, 1);

  await service.ensurePlaces(['AUTO MERCADO PLAZA MAYOR SAN J']);
  assert.deepEqual(
    placeResolver.requests[1]!.fields.map((f) => f.field),
    ['SAN J'],
  );
});

test('ensurePlaces: an answer that omits a field or invents a country stores nothing', async () => {
  for (const spoil of [
    (entries: PlaceEntry[]) => entries.slice(1),
    (entries: PlaceEntry[]) => entries.map((e) => ({ ...e, country: 'Guatemala' })),
  ]) {
    const { service, placeResolver, placeRows } = setup();
    const complete = placeResolver.answer;
    placeResolver.answer = (request) => spoil(complete(request));
    await service.ensurePlaces([LA_TORRE, 'IMPERIAL STORE           ALAJU']);
    assert.equal(placeRows.size, 0);

    // Remembered until the reset, then asked again.
    placeResolver.answer = complete;
    await service.ensurePlaces([LA_TORRE]);
    assert.equal(placeResolver.requests.length, 1);
    service.resetFailures();
    await service.ensurePlaces([LA_TORRE]);
    assert.equal(placeRows.size, 1);
  }
});

test('locate: a purchase at a global chain is placed by the town its own description names', async () => {
  const { service, resolver } = setup();
  // Guatemala through the 17th, Costa Rica from the 18th.
  const complete = resolver.answer;
  resolver.answer = (run) =>
    complete(run).map((a) =>
      a.date >= '2026-04-18' ? { ...a, country: 'CR', location: 'San José' } : a,
    );
  await service.ensureDays(range('2026-04-14', '2026-04-23'));
  await service.ensurePlaces([SUBWAY]);
  const tx = { date: '2026-04-23', description: SUBWAY };

  // The payee has no country, so only the description can say the branch is in Guatemala.
  const chain = await service.locate(tx, { locationKind: 'chain', country: null });
  assert.equal(chain.rule, 'description-country');
  assert.equal(chain.country, 'GT');
  assert.equal(chain.purchaseDate, '2026-04-17');

  // A trailing country code needs no lookup.
  const coded = await service.locate(
    { date: '2026-04-23', description: 'SUBWAY LAS AMERICAS    GT' },
    { locationKind: 'chain', country: null },
  );
  assert.equal(coded.rule, 'description-country');

  // An online charge carries the same kind of field, and it means nothing there.
  const remote = await service.locate(tx, { locationKind: 'remote', country: 'US' });
  assert.equal(remote.rule, 'posting-lag');
  assert.equal(remote.country, 'CR');
});

test('describe: resolves the window and returns the prompt block; null when switched off', async () => {
  const { service, resolver } = setup();
  const text = await service.describe('2026-09-10');
  assert.equal(resolver.runs.length, 1);
  assert.match(text!, /2026-09-01 to 2026-09-10 {2}Guatemala City, Guatemala \(GT\) — observed/);

  process.env.TX_LOCATION_ENABLED = 'false';
  assert.equal(await service.describe('2026-08-10'), null);
  assert.equal(resolver.runs.length, 1);
});
