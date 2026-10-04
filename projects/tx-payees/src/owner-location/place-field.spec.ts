import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCountryCode } from '~/owner-location/country';
import { placeField } from '~/owner-location/place-field';

test('placeField: the last five characters of a 30-character line, when they are letters', () => {
  assert.deepEqual(placeField('CLARO MCE MPC CR         SAN J'), { shape: 'city', value: 'SAN J' });
  assert.deepEqual(placeField('ROSA JAMAICA             ESCUI'), { shape: 'city', value: 'ESCUI' });
  assert.deepEqual(placeField('RESTAURANTE SAN BERNARDINLA AN'), { shape: 'city', value: 'LA AN' });
});

test('placeField: phone numbers, URLs, references and punctuation are not places', () => {
  for (const tail of ['866-7', '40020', 'WWW.A', 'HELP.', 'A   .', ' .  /', '   GT']) {
    assert.equal(placeField('X'.repeat(25) + tail), null, tail);
  }
});

test('placeField: the trailing country of a 25-character line, when it is a real country', () => {
  assert.deepEqual(placeField('UBER *TRIP HELP.UBER.C NL'), { shape: 'country', value: 'NL' });
  assert.equal(placeField('PAGO PLANILLA 15       XX'), null);
  // Month abbreviations and counters end such lines too; they are three characters, not " CC".
  assert.equal(placeField('PAGO DE TARJETA 12345 AGO'), null);
});

test('placeField: any other length has no place field', () => {
  assert.equal(placeField('TF: ACH INMEDIATO 9004228'.slice(0, 24)), null);
  assert.equal(placeField(''), null);
});

test('isCountryCode: real ISO codes only', () => {
  assert.equal(isCountryCode('GT'), true);
  assert.equal(isCountryCode('CR'), true);
  assert.equal(isCountryCode('XX'), false);
  assert.equal(isCountryCode('ZZ'), false);
  assert.equal(isCountryCode('gt'), false);
  assert.equal(isCountryCode('GTM'), false);
});
