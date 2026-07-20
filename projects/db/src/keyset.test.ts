import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from './index';
import { bankTx } from './schema';
import { keysetBefore } from './keyset';

test('keysetBefore returns undefined when there is no cursor', () => {
  assert.equal(keysetBefore(undefined), undefined);
  assert.equal(keysetBefore(null), undefined);
});

test('keysetBefore emits a row-value comparison with bound parameters', () => {
  const { sql, params } = db
    .select()
    .from(bankTx)
    .where(keysetBefore({ date: '2026-07-11', id: '019827c0-0000-7000-8000-000000000000' }))
    .toSQL();

  assert.match(sql, /\("bank_tx"\."date", "bank_tx"\."id"\) < \(\$1::date, \$2::uuid\)/);
  assert.deepEqual(params, ['2026-07-11', '019827c0-0000-7000-8000-000000000000']);
});

test('keysetBefore does NOT emit the OR-of-AND form', () => {
  // The OR form is what Drizzle's own cursor-pagination guide recommends, and it is wrong here:
  // Postgres cannot turn it into an index seek, so it degrades to a filter that rescans from the
  // top of the index. Measured on this database it discarded 1116 rows to return 20.
  const { sql } = db
    .select()
    .from(bankTx)
    .where(keysetBefore({ date: '2026-07-11', id: '019827c0-0000-7000-8000-000000000000' }))
    .toSQL();

  assert.doesNotMatch(sql, /\bor\b/i);
});
