import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '~/replica-db/replica-schema';
import { TxMatcher } from '~/tx-payees/tx-matcher.service';

// An in-memory stand-in for ReplicaDb, set up the same way ReplicaDb.onModuleInit does: create the
// schema and register regexp(). Without that function every REGEXP query fails at prepare().
function makeReplica() {
  const sqlite = new Database(':memory:');
  sqlite.exec(schema.CREATE_SCHEMA_SQL);
  sqlite.function('regexp', (pattern: string, value: string) =>
    value != null && new RegExp(pattern, 'i').test(value) ? 1 : 0,
  );
  return { raw: sqlite, db: drizzle(sqlite, { schema }) };
}

let replica: ReturnType<typeof makeReplica>;
let matcher: TxMatcher;
let seq = 0;

// Ids ascend with insertion, mirroring uuidv7 — so "most recent" tiebreaks the way production does.
function addTx(
  description: string,
  opts: { payeeId?: string; categoryId?: string; date?: string } = {},
) {
  const id = `tx-${String(++seq).padStart(4, '0')}`;
  replica.db
    .insert(schema.bankTx)
    .values({
      id,
      bankAccountId: 'acct-1',
      month: '2026-07',
      date: opts.date ?? '2026-07-01',
      docNo: 'D1',
      description,
      amountCents: -1000,
      payeeId: opts.payeeId ?? null,
      categoryId: opts.categoryId ?? null,
      transferBankAccountId: null,
      reconcile: false,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
    })
    .run();
  return id;
}

function addRule(label: string, pattern: string, priority: number, enabled = true) {
  replica.db
    .insert(schema.matchingRule)
    .values({
      id: `rule-${label}`,
      label,
      pattern,
      priority,
      enabled,
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-01T00:00:00Z',
    })
    .run();
}

describe('TxMatcher', () => {
  before(() => {
    replica = makeReplica();
    matcher = new TxMatcher(replica as unknown as ConstructorParameters<typeof TxMatcher>[0]);
  });
  after(() => replica.raw.close());

  it('prefers an exact description match over a regex rule', () => {
    addRule('spotify', String.raw`\bspotify\b`, 10);
    // Both are reachable via the spotify rule; only the second matches the description exactly.
    addTx('SPOTIFY GT', { payeeId: 'p-regex', categoryId: 'c-regex', date: '2026-01-01' });
    addTx('SPOTIFY  MONTHLY', { payeeId: 'p-exact', categoryId: 'c-exact', date: '2026-02-01' });
    const target = addTx('SPOTIFY  MONTHLY');

    const res = matcher.match({ id: target, description: 'SPOTIFY  MONTHLY' });
    assert.equal(res?.payeeId, 'p-exact');
    assert.equal(res?.categoryId, 'c-exact');
    assert.equal(res?.via, 'exact');
  });

  it('falls back to a regex rule, copying from history rather than the rule', () => {
    addTx('TIGO PAGO 123', { payeeId: 'p-tigo', categoryId: 'c-tigo', date: '2026-03-01' });
    addRule('tigo', String.raw`\btigo\b`, 20);
    const target = addTx('TIGO PAGO 999');

    const res = matcher.match({ id: target, description: 'TIGO PAGO 999' });
    assert.equal(res?.payeeId, 'p-tigo');
    assert.equal(res?.via, 'regex:tigo');
  });

  it('picks the most recent match when history has several', () => {
    addRule('cemaco', String.raw`\bcemaco\b`, 25);
    addTx('CEMACO ZONA 1', { payeeId: 'p-old', categoryId: 'c-old', date: '2026-01-05' });
    addTx('CEMACO ZONA 9', { payeeId: 'p-new', categoryId: 'c-new', date: '2026-06-05' });
    const target = addTx('CEMACO MIRAFLORES');

    assert.equal(matcher.match({ id: target, description: 'CEMACO MIRAFLORES' })?.payeeId, 'p-new');
  });

  it('routes sub-brands via negative lookahead', () => {
    addRule('pedidosya propina', String.raw`\bpedidos\s*ya\s+propina`, 30);
    addRule('pedidosya', String.raw`\bpedidos\s*ya\b(?!\s+propina)`, 40);
    addTx('PEDIDOSYA PROPINA X', {
      payeeId: 'p-propina',
      categoryId: 'c-misc',
      date: '2026-04-01',
    });
    addTx('PEDIDOSYA FOOD X', { payeeId: 'p-food', categoryId: 'c-rest', date: '2026-04-01' });

    const propina = addTx('PEDIDOSYA PROPINA ZZZ');
    const food = addTx('PEDIDOSYA FOOD ZZZ');
    assert.equal(
      matcher.match({ id: propina, description: 'PEDIDOSYA PROPINA ZZZ' })?.payeeId,
      'p-propina',
    );
    assert.equal(matcher.match({ id: food, description: 'PEDIDOSYA FOOD ZZZ' })?.payeeId, 'p-food');
  });

  it('never sources from itself', () => {
    const solo = addTx('UNIQUE MERCHANT XYZ');
    assert.equal(matcher.match({ id: solo, description: 'UNIQUE MERCHANT XYZ' }), null);
  });

  it('skips disabled rules', () => {
    addTx('DISNEY PLUS', { payeeId: 'p-disney', categoryId: 'c-disney', date: '2026-05-01' });
    addRule('disney', String.raw`\bdisney\b`, 50, false);
    const target = addTx('DISNEY SOMETHING ELSE');
    assert.equal(matcher.match({ id: target, description: 'DISNEY SOMETHING ELSE' }), null);
  });

  it('ignores history rows that are only half-mapped', () => {
    addRule('volaris', String.raw`\bvolaris\b`, 60);
    addTx('VOLARIS FLIGHT', { payeeId: 'p-volaris', date: '2026-05-01' }); // no category
    const target = addTx('VOLARIS OTHER');
    assert.equal(matcher.match({ id: target, description: 'VOLARIS OTHER' }), null);
  });

  it('returns null when nothing matches', () => {
    const target = addTx('COMPLETELY NOVEL MERCHANT');
    assert.equal(matcher.match({ id: target, description: 'COMPLETELY NOVEL MERCHANT' }), null);
  });

  it('survives a rule whose pattern is not a valid regex', () => {
    addRule('broken', '([unclosed', 5);
    addTx('WHATEVER MERCHANT', { payeeId: 'p-x', categoryId: 'c-x', date: '2026-05-01' });
    const target = addTx('WHATEVER MERCHANT 2');
    // The bad rule is skipped rather than throwing; nothing else matches this description.
    assert.equal(matcher.match({ id: target, description: 'WHATEVER MERCHANT 2' }), null);
  });
});
