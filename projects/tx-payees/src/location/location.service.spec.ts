import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import type { DawarichClient } from '~/location/dawarich.client';
import { windowDates, type RawPoint } from '~/location/location-day';
import { LocationService } from '~/location/location.service';

const GT: RawPoint = { country_name: 'Guatemala', city: 'Guatemala City' };

/** A Dawarich stand-in that records what was asked of it. */
function fakeClient(pointsByDate: Record<string, RawPoint[]>) {
  const calls: string[] = [];
  const failing = { value: false };
  const client = {
    async pointsForDay(date: string) {
      calls.push(date);
      if (failing.value) {
        throw new Error('dawarich down');
      }
      return pointsByDate[date] ?? [];
    },
  } as unknown as DawarichClient;
  return { client, calls, failing };
}

function makeService(client: DawarichClient, now: string) {
  const service = new LocationService(client, new StructuredLoggerService());
  service.now = () => new Date(now);
  service.onModuleInit();
  return service;
}

const saved = { ...process.env };

beforeEach(() => {
  process.env.LOCATION_CACHE_DB_PATH = ':memory:';
  process.env.DAWARICH_API_KEY = 'test-key';
});

afterEach(() => {
  process.env = { ...saved };
});

test('days: one request per date, summarized in the order asked', async () => {
  const { client, calls } = fakeClient({ '2026-09-03': [GT], '2026-08-25': [GT] });
  const service = makeService(client, '2026-10-01T18:00:00Z');

  const days = await service.days(windowDates('2026-09-03', 10));

  assert.equal(calls.length, 10);
  assert.equal(calls[0], '2026-08-25');
  assert.equal(calls[9], '2026-09-03');
  assert.deepEqual(
    days!.map((d) => d.pointCount),
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  );
  assert.equal(days![9]!.places[0]!.city, 'Guatemala City');
});

test('days: settled days are served from the cache the next time', async () => {
  const everyDay = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, '0')}`, [GT]]),
  );
  const { client, calls } = fakeClient(everyDay);
  const service = makeService(client, '2026-10-01T18:00:00Z');

  await service.days(windowDates('2026-09-10', 10));
  await service.days(windowDates('2026-09-12', 10));

  // Sep 1-10 fetched once; the second window (Sep 3-12) only needs Sep 11 and 12.
  assert.deepEqual(calls.slice(10), ['2026-09-11', '2026-09-12']);
});

test('days: an empty or recent day is re-checked once its 12 hours are up', async () => {
  const { client, calls } = fakeClient({ '2026-09-30': [GT] });
  const service = makeService(client, '2026-10-01T18:00:00Z');
  const window = windowDates('2026-10-01', 10);

  await service.days(window);
  await service.days(window);
  assert.equal(calls.length, 10, 'within 12h nothing is re-fetched');

  service.now = () => new Date('2026-10-02T07:00:00Z');
  await service.days(window);
  // Everything in this window is either empty or too recent to be settled, so all ten go again.
  assert.equal(calls.length, 20);
});

test('days: a Dawarich failure is null, not a partial answer; nothing is cached; it backs off', async () => {
  const { client, calls, failing } = fakeClient({ '2026-09-03': [GT] });
  const service = makeService(client, '2026-10-01T18:00:00Z');
  const window = windowDates('2026-09-03', 10);

  failing.value = true;
  assert.equal(await service.days(window), null);
  assert.equal(calls.length, 1, 'gives up on the first failed request');

  failing.value = false;
  assert.equal(await service.days(window), null, 'still backing off');
  assert.equal(calls.length, 1);

  service.now = () => new Date('2026-10-01T18:06:00Z');
  assert.equal((await service.days(window))!.length, 10);
});

test('days: null without an API key — and never calls Dawarich', async () => {
  const { client, calls } = fakeClient({ '2026-09-03': [GT] });
  delete process.env.DAWARICH_API_KEY;

  assert.equal(await makeService(client, '2026-10-01T18:00:00Z').days(['2026-09-03']), null);
  assert.equal(calls.length, 0);
});
