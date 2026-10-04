import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '~/replica-db/replica-schema';
import { TxMatcher } from '~/payee-resolver/tx-matcher.service';
import { TxAiResolver, isResolved, type MatchOutcome } from '~/payee-resolver/match-outcome';

// The AI tier, stubbed out. Every test here is about tiers 1 and 2, so the stub answers 'none' and
// records whether it was reached — which doubles as an assertion that the earlier tiers really did
// resolve, rather than silently falling through.
class StubAi extends TxAiResolver {
  calls = 0;
  resolve(): Promise<MatchOutcome> {
    this.calls += 1;
    return Promise.resolve({ type: 'none' });
  }
}

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
let ai: StubAi;
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
    ai = new StubAi();
    matcher = new TxMatcher(
      replica as unknown as ConstructorParameters<typeof TxMatcher>[0],
      ai,
      new StructuredLoggerService(),
    );
  });
  after(() => replica.raw.close());

  it('prefers an exact description match over a regex rule', async () => {
    addRule('spotify', String.raw`\bspotify\b`, 10);
    // Both are reachable via the spotify rule; only the second matches the description exactly.
    const older = addTx('SPOTIFY GT', {
      payeeId: 'p-regex',
      categoryId: 'c-regex',
      date: '2026-01-01',
    });
    const exact = addTx('SPOTIFY  MONTHLY', {
      payeeId: 'p-exact',
      categoryId: 'c-exact',
      date: '2026-02-01',
    });
    const target = addTx('SPOTIFY  MONTHLY');

    const res = await matcher.match({ id: target, description: 'SPOTIFY  MONTHLY' });
    assert.equal(res.type, 'exact');
    assert.equal(res.payeeId, 'p-exact');
    assert.equal(res.categoryId, 'c-exact');
    // The audit trail has to name the row the answer came from, not merely that it was exact.
    assert.equal(res.sourceTxId, exact);
    assert.notEqual(res.sourceTxId, older);
  });

  it('falls back to a regex rule, copying from history rather than the rule', async () => {
    const src = addTx('TIGO PAGO 123', {
      payeeId: 'p-tigo',
      categoryId: 'c-tigo',
      date: '2026-03-01',
    });
    addRule('tigo', String.raw`\btigo\b`, 20);
    const target = addTx('TIGO PAGO 999');

    const res = await matcher.match({ id: target, description: 'TIGO PAGO 999' });
    assert.equal(res.type, 'rule');
    assert.equal(res.payeeId, 'p-tigo');
    assert.equal(res.ruleLabel, 'tigo');
    assert.equal(res.sourceTxId, src);
  });

  it('picks the most recent match when history has several', async () => {
    addRule('cemaco', String.raw`\bcemaco\b`, 25);
    addTx('CEMACO ZONA 1', { payeeId: 'p-old', categoryId: 'c-old', date: '2026-01-05' });
    addTx('CEMACO ZONA 9', { payeeId: 'p-new', categoryId: 'c-new', date: '2026-06-05' });
    const target = addTx('CEMACO MIRAFLORES');

    const res = await matcher.match({ id: target, description: 'CEMACO MIRAFLORES' });
    assert.ok(isResolved(res));
    assert.equal(res.payeeId, 'p-new');
  });

  it('routes sub-brands via negative lookahead', async () => {
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
    const rp = await matcher.match({ id: propina, description: 'PEDIDOSYA PROPINA ZZZ' });
    const rf = await matcher.match({ id: food, description: 'PEDIDOSYA FOOD ZZZ' });
    assert.ok(isResolved(rp));
    assert.ok(isResolved(rf));
    assert.equal(rp.payeeId, 'p-propina');
    assert.equal(rf.payeeId, 'p-food');
  });

  it('never sources from itself', async () => {
    const solo = addTx('UNIQUE MERCHANT XYZ');
    const res = await matcher.match({ id: solo, description: 'UNIQUE MERCHANT XYZ' });
    assert.equal(res.type, 'none');
  });

  it('skips disabled rules', async () => {
    addTx('DISNEY PLUS', { payeeId: 'p-disney', categoryId: 'c-disney', date: '2026-05-01' });
    addRule('disney', String.raw`\bdisney\b`, 50, false);
    const target = addTx('DISNEY SOMETHING ELSE');
    const res = await matcher.match({ id: target, description: 'DISNEY SOMETHING ELSE' });
    assert.equal(res.type, 'none');
  });

  it('ignores history rows that are only half-mapped', async () => {
    addRule('volaris', String.raw`\bvolaris\b`, 60);
    addTx('VOLARIS FLIGHT', { payeeId: 'p-volaris', date: '2026-05-01' }); // no category
    const target = addTx('VOLARIS OTHER');
    const res = await matcher.match({ id: target, description: 'VOLARIS OTHER' });
    assert.equal(res.type, 'none');
  });

  it('reaches the AI tier only when both earlier tiers miss', async () => {
    const before = ai.calls;
    const target = addTx('COMPLETELY NOVEL MERCHANT');
    const res = await matcher.match({ id: target, description: 'COMPLETELY NOVEL MERCHANT' });
    assert.equal(res.type, 'none');
    assert.equal(ai.calls, before + 1);

    // ...and not when tier 1 answers.
    addTx('KNOWN MERCHANT', { payeeId: 'p-k', categoryId: 'c-k', date: '2026-06-01' });
    const known = addTx('KNOWN MERCHANT');
    const hit = await matcher.match({ id: known, description: 'KNOWN MERCHANT' });
    assert.equal(hit.type, 'exact');
    assert.equal(ai.calls, before + 1, 'AI tier was consulted despite an exact match');
  });

  it('survives a rule whose pattern is not a valid regex', async () => {
    addRule('broken', '([unclosed', 5);
    addTx('WHATEVER MERCHANT', { payeeId: 'p-x', categoryId: 'c-x', date: '2026-05-01' });
    const target = addTx('WHATEVER MERCHANT 2');
    // The bad rule is skipped rather than throwing; nothing else matches this description.
    const res = await matcher.match({ id: target, description: 'WHATEVER MERCHANT 2' });
    assert.equal(res.type, 'none');
  });
});
