import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDayAnswers, type DayAnswer } from '~/owner-location/day-location-resolver';
import { DAY_SYSTEM_PROMPT, buildDayPrompt } from '~/owner-location/day-prompt';

test('buildDayPrompt: the evidence, then the exact days to answer for', () => {
  const prompt = buildDayPrompt(['2026-05-03', '2026-05-04'], 'Days to resolve: ...');
  assert.ok(prompt.startsWith('Days to resolve: ...'));
  assert.match(
    prompt,
    /Answer for each of these 2 days, exactly once each:\n2026-05-03, 2026-05-04$/,
  );
});

test('DAY_SYSTEM_PROMPT: an assumed line is not an observation and loses to in-person charges', () => {
  assert.match(DAY_SYSTEM_PROMPT, /assumed {3}NOT an observation/);
  assert.match(
    DAY_SYSTEM_PROMPT,
    /Where an assumed line disagrees with in-person charges, the charges win/,
  );
});

test('DAY_SYSTEM_PROMPT: charges are dated by posting, and online ones say nothing', () => {
  assert.match(DAY_SYSTEM_PROMPT, /POSTING date/);
  assert.match(DAY_SYSTEM_PROMPT, /Worth nothing: subscriptions, online orders/);
  assert.match(DAY_SYSTEM_PROMPT, /OPENA, ANTHR/);
});

test('DAY_SYSTEM_PROMPT: a travel day is the country left, and no stray template syntax', () => {
  assert.match(DAY_SYSTEM_PROMPT, /answer with the country the owner LEFT/);
  assert.doesNotMatch(DAY_SYSTEM_PROMPT, /\$\{|undefined/);
});

const day = (date: string, over: Partial<DayAnswer> = {}): DayAnswer => ({
  date,
  country: 'GT',
  location: 'Guatemala City',
  basis: 'observed',
  confidence: 'high',
  reason: 'tracker',
  ...over,
});

test('checkDayAnswers: returns the days in the order asked, with codes normalized', () => {
  const out = checkDayAnswers(
    ['2026-05-03', '2026-05-04'],
    [day('2026-05-04', { country: ' cr ', location: ' San José ' }), day('2026-05-03')],
  );
  assert.deepEqual(
    out.map((d) => [d.date, d.country, d.location]),
    [
      ['2026-05-03', 'GT', 'Guatemala City'],
      ['2026-05-04', 'CR', 'San José'],
    ],
  );
});

test('checkDayAnswers: a day with no country is unknown, with no place', () => {
  const [out] = checkDayAnswers(
    ['2026-05-03'],
    [day('2026-05-03', { country: null, location: 'somewhere', basis: 'inferred' })],
  );
  assert.equal(out!.basis, 'unknown');
  assert.equal(out!.location, null);
});

test('checkDayAnswers: an omitted, repeated or unasked day, or a bad code, throws', () => {
  const dates = ['2026-05-03', '2026-05-04'];
  assert.throws(() => checkDayAnswers(dates, [day('2026-05-03')]), /no answer for 2026-05-04/);
  assert.throws(
    () => checkDayAnswers(dates, [day('2026-05-03'), day('2026-05-03'), day('2026-05-04')]),
    /twice/,
  );
  assert.throws(
    () => checkDayAnswers(dates, [day('2026-05-03'), day('2026-05-04'), day('2026-05-05')]),
    /not asked for/,
  );
  assert.throws(
    () => checkDayAnswers(dates, [day('2026-05-03', { country: 'GUA' }), day('2026-05-04')]),
    /not an ISO/,
  );
});
