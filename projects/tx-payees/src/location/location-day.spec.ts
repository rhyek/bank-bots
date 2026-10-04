import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  daysBetween,
  describeTrackerDay,
  isSettled,
  summarizeDay,
  windowDates,
  type LocationDay,
} from '~/location/location-day';

const point = (country_name: string | null, city: string | null) => ({ country_name, city });

const day = (date: string, ...places: [string | null, string | null, number][]): LocationDay => ({
  date,
  pointCount: places.reduce((n, p) => n + p[2], 0),
  places: places.map(([country, city, points]) => ({ country, city, points })),
  assumed: false,
});

test('summarizeDay: groups points by country + city, busiest first', () => {
  const out = summarizeDay('2026-09-20', [
    point('Guatemala', 'Guatemala City'),
    point('Costa Rica', 'San José'),
    point('Costa Rica', 'San José'),
    point('Costa Rica', 'Río Segundo'),
  ]);
  assert.deepEqual(out, {
    date: '2026-09-20',
    pointCount: 4,
    places: [
      { country: 'Costa Rica', city: 'San José', points: 2 },
      // Ties keep first-seen order.
      { country: 'Guatemala', city: 'Guatemala City', points: 1 },
      { country: 'Costa Rica', city: 'Río Segundo', points: 1 },
    ],
    assumed: false,
  });
});

test('summarizeDay: a day with no points has no places', () => {
  assert.deepEqual(summarizeDay('2026-10-01', []), {
    date: '2026-10-01',
    pointCount: 0,
    places: [],
    assumed: false,
  });
});

test('summarizeDay: blank city or country is kept as null, not as a place name', () => {
  const out = summarizeDay('2026-09-25', [point('Guatemala', ''), point(null, null)]);
  assert.deepEqual(out.places, [
    { country: 'Guatemala', city: null, points: 1 },
    { country: null, city: null, points: 1 },
  ]);
});

test('windowDates: the date and the nine days before it, oldest first', () => {
  const dates = windowDates('2026-09-03', 10);
  assert.equal(dates.length, 10);
  assert.equal(dates[0], '2026-08-25');
  assert.equal(dates[9], '2026-09-03');
});

test('isSettled: only a day with points that is more than two days old', () => {
  assert.equal(
    isSettled(day('2026-09-27', ['Guatemala', 'Guatemala City', 3]), '2026-10-01'),
    true,
  );
  assert.equal(
    isSettled(day('2026-09-29', ['Guatemala', 'Guatemala City', 3]), '2026-10-01'),
    false,
  );
  // An empty day may still be filled in by a late upload, however old it is.
  assert.equal(isSettled(day('2026-08-18'), '2026-10-01'), false);
});

test('addDays and daysBetween: calendar arithmetic across a month boundary', () => {
  assert.equal(addDays('2026-03-01', -2), '2026-02-27');
  assert.equal(addDays('2026-09-28', 5), '2026-10-03');
  assert.equal(daysBetween('2026-09-24', '2026-10-04'), 10);
  assert.equal(daysBetween('2026-10-04', '2026-09-24'), -10);
});

test('describeTrackerDay: an observed day names its country and its busiest cities', () => {
  assert.equal(
    describeTrackerDay(
      day('2026-09-12', ['Costa Rica', 'Tempate', 6], ['Costa Rica', 'Guanacaste Province', 2]),
    ),
    'observed  Costa Rica (Tempate, Guanacaste Province)',
  );
});

test('describeTrackerDay: a travel day names both countries, busiest first', () => {
  assert.equal(
    describeTrackerDay(
      day('2026-09-20', ['Costa Rica', 'San José', 7], ['Guatemala', 'Guatemala City', 6]),
    ),
    'observed  Costa Rica (San José) + Guatemala (Guatemala City)',
  );
});

test('describeTrackerDay: an empty day is missing, not guessed', () => {
  assert.equal(describeTrackerDay(day('2026-09-21')), 'missing');
});

test('describeTrackerDay: points with no country do not invent a second country', () => {
  assert.equal(
    describeTrackerDay(
      day('2026-09-25', ['Guatemala', 'Tecpán', 5], [null, null, 2], ['Guatemala', null, 4]),
    ),
    'observed  Guatemala (Tecpán)',
  );
  assert.equal(
    describeTrackerDay(day('2026-09-26', [null, null, 3])),
    'observed  place not identified',
  );
});

test('describeTrackerDay: lists at most four cities per country', () => {
  const text = describeTrackerDay(
    day(
      '2026-09-25',
      ['Guatemala', 'A', 9],
      ['Guatemala', 'B', 8],
      ['Guatemala', 'C', 7],
      ['Guatemala', 'D', 6],
      ['Guatemala', 'E', 5],
    ),
  );
  assert.equal(text, 'observed  Guatemala (A, B, C, D)');
});

const filler = {
  country_name: 'Costa Rica',
  city: 'San José',
  topic: 'Google Maps Phone Timeline Export',
};

test('summarizeDay: a Google import day on one coordinate is assumed, not observed', () => {
  const points = Array.from({ length: 96 }, () => ({
    ...filler,
    latitude: '9.93',
    longitude: '-84.08',
  }));
  assert.equal(summarizeDay('2026-01-15', points).assumed, true);
});

test('summarizeDay: an import day that moves, or any live-tracker day, is observed', () => {
  const moving = [
    { ...filler, latitude: '9.93', longitude: '-84.08' },
    { ...filler, latitude: '9.99', longitude: '-84.20' },
  ];
  assert.equal(summarizeDay('2026-04-21', moving).assumed, false);
  const live = [{ country_name: 'Costa Rica', city: 'Tempate', latitude: 10.4, longitude: -85.7 }];
  assert.equal(summarizeDay('2026-09-12', live).assumed, false);
});

test('describeTrackerDay: an assumed day is labelled as one', () => {
  assert.equal(
    describeTrackerDay({ ...day('2026-05-03', ['Costa Rica', 'San José', 96]), assumed: true }),
    'assumed   Costa Rica (San José)',
  );
});
