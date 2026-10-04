import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SYSTEM_PROMPT, buildUserPrompt } from '~/payee-resolver/ai/prompt';

const tx = {
  description: 'IMPERIAL STORE           ALAJU',
  date: '2026-09-23',
  amountCents: -9499,
};

test('buildUserPrompt: appends the location block after the transaction', () => {
  const location = 'where the owner was:\n  2026-09-20  Alajuela, Costa Rica (CR) — observed';
  const prompt = buildUserPrompt({ ...tx, location });
  assert.ok(prompt.indexOf('date: 2026-09-23') < prompt.indexOf('where the owner was'));
  assert.ok(prompt.endsWith(location));
});

test('buildUserPrompt: says nothing about location when there is none', () => {
  const prompt = buildUserPrompt({ ...tx, location: null });
  assert.doesNotMatch(prompt, /location/i);
});

test('SYSTEM_PROMPT: location is a hint that never overrides history', () => {
  assert.match(SYSTEM_PROMPT, /## Where the owner was/);
  assert.match(SYSTEM_PROMPT, /never overrides history/i);
});

test('buildUserPrompt: states the amount in US dollars', () => {
  assert.match(
    buildUserPrompt(tx),
    /amount_cents: -9499 \(USD cents, i\.e\. -94\.99 USD; negative = debit\)/,
  );
});

test('SYSTEM_PROMPT: amounts are USD whatever the merchant charges in', () => {
  assert.match(SYSTEM_PROMPT, /## Amounts are US dollars/);
});

test('SYSTEM_PROMPT: a known merchant with an uncertain category is still a match', () => {
  assert.match(SYSTEM_PROMPT, /only the category is uncertain, that\s+is a match/);
});

test('SYSTEM_PROMPT: bank-generated lines are settled from history, without a web search', () => {
  assert.match(SYSTEM_PROMPT, /RETIRO EFECTIVO COMPENSADO/);
  assert.match(SYSTEM_PROMPT, /return no match without searching the web/);
});

test('SYSTEM_PROMPT: says what Travel covers and what Gas does not', () => {
  assert.match(SYSTEM_PROMPT, /Travel is for flights, lodging and car rental/);
  assert.match(SYSTEM_PROMPT, /taxis and ride-hailing are Miscellaneous/);
});

test('SYSTEM_PROMPT: contains no stray template syntax', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /\$\{|undefined/);
});
