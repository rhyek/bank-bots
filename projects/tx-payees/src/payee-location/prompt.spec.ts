import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAYEE_LOCATION_SYSTEM_PROMPT, buildPayeeLocationPrompt } from '~/payee-location/prompt';

const input = {
  name: 'Imperial Store',
  txCount: 2,
  firstDate: '2026-09-23',
  lastDate: '2026-09-23',
  samples: [
    { date: '2026-09-23', description: 'IMPERIAL STORE           ALAJU', amountCents: -1182 },
  ],
  placeFields: [{ field: 'city "ALAJU"', count: 2 }],
  trigger: {
    date: '2026-09-23',
    description: 'IMPERIAL STORE           ALAJU',
    ownerCountry: 'CR',
    ownerLocation: 'Alajuela',
  },
};

test('buildPayeeLocationPrompt: the payee, its lines verbatim, its place fields and the trigger', () => {
  const prompt = buildPayeeLocationPrompt(input);
  assert.match(prompt, /payee: "Imperial Store"/);
  assert.match(prompt, /transactions: 2, 2026-09-23 to 2026-09-23/);
  assert.match(prompt, / {2}2026-09-23 {2}"IMPERIAL STORE {11}ALAJU" {2}-11\.82 USD/);
  assert.match(prompt, / {2}city "ALAJU": 2/);
  assert.match(prompt, /prompted this lookup: 2026-09-23 "IMPERIAL STORE {11}ALAJU"/);
  assert.match(prompt, /where the owner was when it was bought: Alajuela, Costa Rica \(CR\)/);
});

test("buildPayeeLocationPrompt: says so when the owner's whereabouts are not known", () => {
  const prompt = buildPayeeLocationPrompt({
    ...input,
    trigger: { ...input.trigger, ownerCountry: null, ownerLocation: null },
  });
  assert.match(prompt, /where the owner was when it was bought: not known/);
  const countryOnly = buildPayeeLocationPrompt({
    ...input,
    trigger: { ...input.trigger, ownerLocation: null },
  });
  assert.match(countryOnly, /when it was bought: Costa Rica \(CR\)/);
});

test('PAYEE_LOCATION_SYSTEM_PROMPT: defines the four kinds and prefers unknown to a guess', () => {
  for (const kind of ['local', 'chain', 'remote', 'unknown']) {
    assert.match(PAYEE_LOCATION_SYSTEM_PROMPT, new RegExp(`^${kind} {2,}`, 'm'));
  }
  assert.match(PAYEE_LOCATION_SYSTEM_PROMPT, /Answer unknown rather than guess/);
  // A bill is paid from anywhere, so it must not be filed as a place the owner goes to.
  assert.match(PAYEE_LOCATION_SYSTEM_PROMPT, /whether the owner has to be there to pay/);
  assert.match(PAYEE_LOCATION_SYSTEM_PROMPT, /^remote {2,}Paid without going anywhere/m);
  // A global brand is a chain with no country, whatever country the owner's charges are from.
  assert.match(PAYEE_LOCATION_SYSTEM_PROMPT, /country = null when the brand has branches in many/);
  assert.match(PAYEE_LOCATION_SYSTEM_PROMPT, /NOT from where the owner's charges happen to be/);
  assert.match(PAYEE_LOCATION_SYSTEM_PROMPT, /about the BUSINESS, not the owner/);
  // Without this the agent explained a charge posted after a flight as someone else's purchase.
  assert.match(PAYEE_LOCATION_SYSTEM_PROMPT, /they bought it before leaving/);
  assert.doesNotMatch(PAYEE_LOCATION_SYSTEM_PROMPT, /\$\{|undefined/);
});
