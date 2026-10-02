import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numberOccurrences } from './occurrences';

const tx = (over: Partial<Parameters<typeof numberOccurrences>[0][number]> = {}) => ({
  bankAccountId: 'acc-1',
  month: '2026-08',
  date: '2026-08-12',
  docNo: '81100000',
  description: 'PEDIDOSYA PROPINA',
  amountCents: -121,
  ...over,
});

test('numberOccurrences: distinct rows are all occurrence 1', () => {
  const out = numberOccurrences([tx(), tx({ amountCents: -162 }), tx({ date: '2026-08-14' })]);
  assert.deepEqual(
    out.map((t) => t.occurrence),
    [1, 1, 1],
  );
});

test('numberOccurrences: identical rows are numbered in statement order', () => {
  const out = numberOccurrences([tx(), tx({ description: 'OTHER' }), tx(), tx()]);
  assert.deepEqual(
    out.map((t) => t.occurrence),
    [1, 1, 2, 3],
  );
});

test('numberOccurrences: same row on another account is not a repeat', () => {
  const out = numberOccurrences([tx(), tx({ bankAccountId: 'acc-2' })]);
  assert.deepEqual(
    out.map((t) => t.occurrence),
    [1, 1],
  );
});

test('numberOccurrences: leaves the bank fields untouched', () => {
  const [first, second] = numberOccurrences([tx(), tx()]);
  assert.equal(second!.docNo, first!.docNo);
  assert.equal(second!.description, first!.description);
});
