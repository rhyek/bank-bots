import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '~/replica-db/replica-schema';
import { testRegex } from '~/payee-resolver/ai/read-tools';
import type { ReplicaDb } from '~/replica-db/replica-db.service';

function makeReplica() {
  const sqlite = new Database(':memory:');
  sqlite.exec(schema.CREATE_SCHEMA_SQL);
  sqlite.function('regexp', (pattern: string, value: string) =>
    value != null && new RegExp(pattern, 'i').test(value) ? 1 : 0,
  );
  return { raw: sqlite, db: drizzle(sqlite, { schema }) } as unknown as ReplicaDb;
}

let replica: ReplicaDb;
let seq = 0;

function addPayee(id: string, name: string) {
  replica.db
    .insert(schema.payee)
    .values({ id, name, createdAt: 'T', updatedAt: 'T' })
    .onConflictDoNothing()
    .run();
}

function addTx(description: string, payeeId?: string) {
  const id = `tx-${String(++seq).padStart(4, '0')}`;
  replica.db
    .insert(schema.bankTx)
    .values({
      id,
      bankAccountId: 'a1',
      month: '2026-07',
      date: '2026-07-01',
      docNo: 'D',
      description,
      amountCents: -100,
      payeeId: payeeId ?? null,
      categoryId: payeeId ? 'c1' : null,
      transferBankAccountId: null,
      reconcile: false,
      createdAt: 'T',
      updatedAt: 'T',
    })
    .run();
  return id;
}

describe('testRegex', () => {
  before(() => {
    replica = makeReplica();
    addPayee('p-amazon', 'Amazon');
    addPayee('p-uber', 'Uber');
    // Amazon's signature shape: stable prefix, 9-char random order id.
    for (const s of ['0B6HF7553', '0N78947I3', '282VY2683', 'BC42B9BS2']) {
      addTx(`AMAZON MKTPL*${s}   A   .`, 'p-amazon');
    }
    addTx('UBER *TRIP  NL', 'p-uber');
    addTx('UBER*RIDES  GT', 'p-uber');
    // A mapped row that a sloppy pattern could sweep in, plus two unmapped Amazons.
    addTx('AMAZON PRIME MEMBERSHIP', 'p-uber');
    addTx('AMAZON MKTPL*ZZ1QQ8871   A   .');
    addTx('AMAZON MKTPL*YY7TT2213   A   .');
    // Enough unrelated mapped history for the share test to mean something: below
    // MIN_HISTORY_FOR_SHARE the ratio is skipped entirely, so without this the over-broad case
    // could not be exercised at all.
    addPayee('p-filler', 'Filler Merchant');
    for (let i = 0; i < 60; i += 1) {
      addTx(`FILLER MERCHANT ${i}  GT`, 'p-filler');
    }
  });
  after(() => (replica as unknown as { raw: Database.Database }).raw.close());

  it('reports payee agreement for a good pattern', () => {
    const r = testRegex(replica, String.raw`\bamazon\s+mktpl\b`);
    assert.equal(r.ok, true);
    assert.equal(r.mapped.total, 4);
    assert.deepEqual(r.mapped.byPayee, [{ payee: 'Amazon', count: 4 }]);
    assert.equal(r.unmappedWouldCatch, 2, 'should resolve both unmapped Amazon rows');
  });

  // The signal that matters most: the agent must be able to see that a pattern is pulling in
  // transactions belonging to more than one payee.
  it('surfaces disagreement when a pattern is too loose', () => {
    const r = testRegex(replica, String.raw`\bamazon\b`);
    assert.equal(r.mapped.byPayee.length, 2, 'expected the pattern to straddle two payees');
    const names = r.mapped.byPayee.map((b) => b.payee).sort();
    assert.deepEqual(names, ['Amazon', 'Uber']);
  });

  it('rejects a pattern that is not a valid regex', () => {
    const r = testRegex(replica, '([unclosed');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /not a valid regex/);
  });

  it('rejects a pattern that matches nearly everything', () => {
    const r = testRegex(replica, '.*');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /too broad/);
  });

  it('reports which existing rules overlap', () => {
    replica.db
      .insert(schema.matchingRule)
      .values({
        id: 'r-amazon',
        label: 'amazon',
        pattern: String.raw`\bamazon(\.com|\sMKTPL)\b`,
        priority: 70,
        enabled: true,
        createdAt: 'T',
        updatedAt: 'T',
      })
      .run();
    const r = testRegex(replica, String.raw`\bamazon\s+mktpl\b`);
    assert.equal(r.overlappingRules.length, 1);
    assert.equal(r.overlappingRules[0].label, 'amazon');
  });

  // A catastrophically backtracking pattern would run against every description on every future
  // match, so it must be rejected at write time. Crucially it has to be rejected WITHOUT being run:
  // timing it would mean executing it first, and (a+)+$ against a 34-char string is ~2^34 steps —
  // the check would hang instead of reporting. If this test ever times out, that guard has
  // regressed into a timing-only one.
  it('rejects a nested-quantifier pattern without executing it', () => {
    for (let i = 0; i < 60; i += 1) {
      addTx(`${'a'.repeat(34)}X${i}`);
    }
    const started = Date.now();
    for (const evil of ['(a+)+$', '(a*)*$', String.raw`(\d+)*$`, '([a-z]+)+X']) {
      const r = testRegex(replica, evil);
      assert.equal(r.ok, false, `${evil} was accepted`);
      assert.match(r.reason ?? '', /backtracks exponentially/);
    }
    assert.ok(Date.now() - started < 1000, 'guard executed the pattern instead of rejecting it');
  });

  it('still accepts an ordinary quantifier', () => {
    const r = testRegex(replica, String.raw`\bnintendo\s+CC\d+`);
    assert.equal(r.ok, true, r.reason ?? 'rejected');
  });
});
