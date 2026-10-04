import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bankKeyParamsSchema, runIdParamsSchema, scrapeBodySchema } from './scrape.dto';

test('scrape body: an empty body is accepted, and is not a dry run', () => {
  assert.deepEqual(scrapeBodySchema.parse({}), { dryRun: false });
});

test('scrape body: a request with no body at all is accepted', () => {
  // Express 5 leaves `req.body` undefined when a POST carries no body.
  assert.deepEqual(scrapeBodySchema.parse(undefined), { dryRun: false });
});

test('scrape body: months, account and dryRun pass through', () => {
  const body = { months: ['2026-09', '2026-10'], account: '904201043', dryRun: true };
  assert.deepEqual(scrapeBodySchema.parse(body), body);
});

test('scrape body: a month that is not YYYY-MM is rejected', () => {
  for (const month of ['2026-9', '2026-13', 'sept', '2026-09-01']) {
    assert.equal(scrapeBodySchema.safeParse({ months: [month] }).success, false, month);
  }
});

test('scrape body: an empty months list is rejected', () => {
  assert.equal(scrapeBodySchema.safeParse({ months: [] }).success, false);
});

test('scrape body: an unknown field is rejected', () => {
  assert.equal(scrapeBodySchema.safeParse({ month: '2026-09' }).success, false);
});

test('bank key param: the three bank keys are accepted', () => {
  for (const bankKey of ['bancoIndustrialGt', 'bacGt', 'bacCr']) {
    assert.deepEqual(bankKeyParamsSchema.parse({ bankKey }), { bankKey });
  }
});

test('bank key param: an unknown bank key is rejected', () => {
  assert.equal(bankKeyParamsSchema.safeParse({ bankKey: 'nope' }).success, false);
});

test('run id param: only a uuid is accepted', () => {
  // The id is compared against a uuid column: anything else would fail in Postgres as a 500.
  assert.equal(runIdParamsSchema.safeParse({ runId: 'nope' }).success, false);
  assert.equal(
    runIdParamsSchema.safeParse({ runId: '0199b1c2-7a3e-7c1d-9f00-2b6d1e4a5c77' }).success,
    true,
  );
});
