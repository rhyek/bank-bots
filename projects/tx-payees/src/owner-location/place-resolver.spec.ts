import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PLACE_SYSTEM_PROMPT,
  buildPlacePrompt,
  checkPlaceAnswers,
} from '~/owner-location/place-resolver';

test('buildPlacePrompt: each field with the descriptions it was read from, verbatim', () => {
  const prompt = buildPlacePrompt({
    fields: [
      { field: 'GUATE', samples: ['LA TORRE ZONA 14         GUATE'] },
      { field: 'ANTHR', samples: ['CLAUDE.AI SUBSCRIPTION   ANTHR'] },
    ],
  });
  assert.match(prompt, /field "GUATE", seen in:\n {2}"LA TORRE ZONA 14 {9}GUATE"/);
  assert.match(prompt, /field "ANTHR", seen in:\n {2}"CLAUDE\.AI SUBSCRIPTION {3}ANTHR"/);
});

test('PLACE_SYSTEM_PROMPT: null beats a guess, and a brand name is not a place', () => {
  assert.match(PLACE_SYSTEM_PROMPT, /A wrong country is worse than none/);
  assert.match(PLACE_SYSTEM_PROMPT, /"OPENA" on an OpenAI charge/);
  assert.doesNotMatch(PLACE_SYSTEM_PROMPT, /\$\{|undefined/);
});

test('checkPlaceAnswers: in the order asked, codes normalized, no place without a country', () => {
  const out = checkPlaceAnswers(
    ['GUATE', 'ANTHR'],
    [
      { field: 'ANTHR', country: null, place: 'Anthropic' },
      { field: 'GUATE', country: ' gt ', place: ' Guatemala City ' },
    ],
  );
  assert.deepEqual(out, [
    { field: 'GUATE', country: 'GT', place: 'Guatemala City' },
    { field: 'ANTHR', country: null, place: null },
  ]);
});

test('checkPlaceAnswers: an omitted, repeated or unasked field, or a bad code, throws', () => {
  const guate = { field: 'GUATE', country: 'GT', place: 'Guatemala City' };
  assert.throws(() => checkPlaceAnswers(['GUATE', 'SAN J'], [guate]), /no answer for "SAN J"/);
  assert.throws(() => checkPlaceAnswers(['GUATE'], [guate, guate]), /twice/);
  assert.throws(
    () => checkPlaceAnswers(['GUATE'], [guate, { ...guate, field: 'ALAJU' }]),
    /not asked about/,
  );
  assert.throws(() => checkPlaceAnswers(['GUATE'], [{ ...guate, country: 'GUA' }]), /not an ISO/);
});
