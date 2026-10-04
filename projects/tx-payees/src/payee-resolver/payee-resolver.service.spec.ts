import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { and, eq } from 'drizzle-orm';
import { AppEvents } from '~/events/app-events';
import type { OwnerLocationService } from '~/owner-location/owner-location.service';
import type { ResolvedDay } from '~/owner-location/resolved-day';
import { locateTx, type PayeePlace, type TxLocation } from '~/owner-location/tx-location';
import type { PayeeLocationAnswer } from '~/payee-location/payee-location-matcher';
import type {
  PayeeLocationService,
  PayeeLocationTrigger,
} from '~/payee-location/payee-location.service';
import { TxAiResolver, type MatchOutcome, type MatchableTx } from '~/payee-resolver/match-outcome';
import type { MatchWriter } from '~/payee-resolver/match-writer.service';
import { PayeeResolver } from '~/payee-resolver/payee-resolver.service';
import { TxMatcher } from '~/payee-resolver/tx-matcher.service';
import { bankTx, matcherResult, payee } from '~/replica-db/replica-schema';
import type { ReplicaDb } from '~/replica-db/replica-db.service';
import { addPayee, addResult, addTx, makeReplica, nextId } from '~/testing/replica';

const LA_TORRE = 'LA TORRE ZONA 14         GUATE';
const IMPERIAL = 'IMPERIAL STORE           ALAJU';

/** The AI tier, scripted. By default it finds nothing. */
class StubAi extends TxAiResolver {
  calls = 0;
  answer: (tx: MatchableTx) => MatchOutcome = () => ({ type: 'none' });
  resolve(tx: MatchableTx): Promise<MatchOutcome> {
    this.calls += 1;
    return Promise.resolve(this.answer(tx));
  }
}

/** MatchWriter with Postgres and replication collapsed: each write lands in the replica at once. */
function fakeWriter(replica: ReplicaDb) {
  return {
    async applyMatch(txId: string, payeeId: string, categoryId: string) {
      replica.db.update(bankTx).set({ payeeId, categoryId }).where(eq(bankTx.id, txId)).run();
    },
    async recordResult(txId: string, outcome: MatchOutcome) {
      addResult(replica, txId, outcome.type);
    },
    async applyLocation(txId: string, location: TxLocation, columnsChanged: boolean) {
      if (columnsChanged) {
        replica.db
          .update(bankTx)
          .set({ country: location.country, location: location.location })
          .where(eq(bankTx.id, txId))
          .run();
      }
      addResult(replica, txId, 'location', location);
    },
  } as unknown as MatchWriter;
}

/** Resolved days, in memory. Every day is Guatemala City unless a test says otherwise. */
function fakeOwnerLocation() {
  const state = {
    enabled: true,
    days: new Map<string, ResolvedDay>(),
    ensured: [] as string[][],
    places: [] as string[][],
    resets: 0,
    failLocate: false,
  };
  const at = (date: string): ResolvedDay =>
    state.days.get(date) ?? {
      date,
      country: 'GT',
      location: 'Guatemala City',
      basis: 'observed',
      confidence: 'high',
      provisional: false,
      resolvedAt: '2026-10-01T00:00:00Z',
    };
  const service = {
    get enabled() {
      return state.enabled;
    },
    async ensureDays(dates: string[]) {
      state.ensured.push(dates);
    },
    async ensurePlaces(descriptions: string[]) {
      state.places.push(descriptions);
    },
    async locate({ date: txDate }: { date: string }, place: PayeePlace | null) {
      if (state.failLocate) {
        throw new Error('postgres is down');
      }
      const window = new Map<string, ResolvedDay>();
      for (let i = 0; i < 10; i += 1) {
        const date = new Date(Date.parse(`${txDate}T00:00:00Z`) - i * 86_400_000)
          .toISOString()
          .slice(0, 10);
        window.set(date, at(date));
      }
      return locateTx(txDate, place, window);
    },
    resetFailures() {
      state.resets += 1;
    },
  } as unknown as OwnerLocationService;
  return { service, state };
}

/** The payee location matcher's service, scripted: records who was asked and sets the kind. */
function fakePayeeLocation(replica: ReplicaDb) {
  const state = {
    calls: [] as { payeeId: string; trigger: PayeeLocationTrigger }[],
    answer: { kind: 'chain', country: 'GT', location: null } as Partial<PayeeLocationAnswer>,
    fail: false,
  };
  const service = {
    async resolve(payeeId: string, trigger: PayeeLocationTrigger) {
      state.calls.push({ payeeId, trigger });
      if (state.fail) {
        throw new Error('agent stalled');
      }
      replica.db
        .update(payee)
        .set({
          locationKind: state.answer.kind,
          country: state.answer.country,
          location: state.answer.location,
        })
        .where(eq(payee.id, payeeId))
        .run();
      return { confidence: 'high', summary: '', ...state.answer } as PayeeLocationAnswer;
    },
  } as unknown as PayeeLocationService;
  return { service, state };
}

let replica: ReplicaDb;
let ai: StubAi;
let owner: ReturnType<typeof fakeOwnerLocation>;
let payeeLocation: ReturnType<typeof fakePayeeLocation>;
let resolver: PayeeResolver;

beforeEach(() => {
  replica = makeReplica();
  ai = new StubAi();
  owner = fakeOwnerLocation();
  payeeLocation = fakePayeeLocation(replica);
  resolver = new PayeeResolver(
    replica,
    new TxMatcher(replica, ai, new StructuredLoggerService()),
    fakeWriter(replica),
    ai,
    new AppEvents(),
    owner.service,
    payeeLocation.service,
    new StructuredLoggerService(),
  );
  resolver.onModuleInit();
});

afterEach(() => {
  resolver.onModuleDestroy();
});

async function run(...txIds: string[]) {
  for (const id of txIds) {
    resolver.enqueue(id);
  }
  await resolver.queue.onIdle();
}

const txRow = (id: string) => replica.db.select().from(bankTx).where(eq(bankTx.id, id)).get()!;
const results = (id: string, type: string) =>
  replica.db
    .select()
    .from(matcherResult)
    .where(and(eq(matcherResult.bankTxId, id), eq(matcherResult.type, type)))
    .orderBy(matcherResult.id)
    .all();

/** Costa Rica through the 20th, Guatemala from the 21st: the trip around IMPERIAL STORE. */
function trip() {
  for (let day = 11; day <= 20; day += 1) {
    const date = `2026-09-${day}`;
    owner.state.days.set(date, {
      date,
      country: 'CR',
      location: day === 20 ? 'Alajuela' : 'Tamarindo, Guanacaste',
      basis: 'observed',
      confidence: 'high',
      provisional: false,
      resolvedAt: '2026-10-01T00:00:00Z',
    });
  }
}

test('a new transaction is matched, then located, in that order', async () => {
  const known = addPayee(replica, 'La Torre', { locationKind: 'chain', country: 'GT' });
  addTx(replica, LA_TORRE, { payeeId: known, categoryId: 'groceries', date: '2026-06-01' });
  const id = addTx(replica, LA_TORRE, { date: '2026-07-10' });

  await run(id);

  assert.equal(txRow(id).payeeId, known);
  assert.equal(txRow(id).country, 'GT');
  assert.equal(txRow(id).location, 'Guatemala City');
  assert.equal(owner.state.ensured[0]!.length, 10, 'its ten-day window was resolved first');
  assert.deepEqual(results(id, 'location')[0]!.data, {
    purchaseDate: '2026-07-08',
    rule: 'single-country',
    country: 'GT',
    location: 'Guatemala City',
    final: true,
  });
});

test('a transaction that already has a payee is located without touching the matcher', async () => {
  const known = addPayee(replica, 'La Torre', { locationKind: 'chain', country: 'GT' });
  const id = addTx(replica, 'SOMETHING NEW            GUATE', {
    payeeId: known,
    categoryId: 'groceries',
    date: '2026-07-10',
  });

  await run(id);

  assert.equal(ai.calls, 0);
  assert.equal(results(id, 'exact').length, 0);
  assert.equal(txRow(id).country, 'GT');
});

test('a transaction the AI tier gave up on is located, not asked about again', async () => {
  const id = addTx(replica, 'TF: ACH INMEDIATO 9004228', { date: '2026-07-10' });
  addResult(replica, id, 'none');

  await run(id);

  assert.equal(ai.calls, 0);
  assert.equal(results(id, 'none').length, 1);
  assert.equal(txRow(id).payeeId, null);
  assert.equal(txRow(id).country, 'GT');
});

test('payee location: runs for a payee with no kind, whichever tier matched it', async () => {
  const unplaced = addPayee(replica, 'La Torre');
  addTx(replica, LA_TORRE, { payeeId: unplaced, categoryId: 'groceries', date: '2026-06-01' });
  const id = addTx(replica, LA_TORRE, { date: '2026-07-10' });

  await run(id);

  assert.equal(payeeLocation.state.calls.length, 1);
  assert.deepEqual(payeeLocation.state.calls[0], {
    payeeId: unplaced,
    trigger: {
      txId: id,
      date: '2026-07-10',
      description: LA_TORRE,
      // The matcher is handed the transaction's own location.
      ownerCountry: 'GT',
      ownerLocation: 'Guatemala City',
    },
  });
});

test('payee location: runs right after the AI tier creates a payee', async () => {
  const id = addTx(replica, 'ROSA JAMAICA             ESCUI', { date: '2026-07-10' });
  let created = '';
  ai.answer = () => {
    created = addPayee(replica, 'Rosa Jamaica Beach Club');
    return { type: 'ai', payeeId: created, categoryId: 'restaurants', data: { summary: '' } };
  };

  await run(id);

  assert.equal(txRow(id).payeeId, created);
  assert.deepEqual(
    payeeLocation.state.calls.map((c) => c.payeeId),
    [created],
  );
});

test('payee location: never for a payee that already has a kind, "unknown" included', async () => {
  for (const locationKind of ['local', 'chain', 'remote', 'unknown']) {
    const placed = addPayee(replica, `Payee ${locationKind}`, { locationKind });
    await run(
      addTx(replica, nextId('DESC'), { payeeId: placed, categoryId: 'c', date: '2026-07-10' }),
    );
  }
  assert.equal(payeeLocation.state.calls.length, 0);
});

test('payee location: not for a transaction that ends up with no payee', async () => {
  await run(addTx(replica, 'PERSONAL', { date: '2026-07-10' }));
  assert.equal(ai.calls, 1);
  assert.equal(payeeLocation.state.calls.length, 0);
});

test('payee location: a failed lookup is not repeated for the same payee in the same sweep', async () => {
  const unplaced = addPayee(replica, 'La Torre');
  const a = addTx(replica, LA_TORRE, { payeeId: unplaced, categoryId: 'c', date: '2026-07-10' });
  const b = addTx(replica, LA_TORRE, { payeeId: unplaced, categoryId: 'c', date: '2026-07-11' });
  payeeLocation.state.fail = true;

  await run(a, b);
  assert.equal(payeeLocation.state.calls.length, 1);
  // The failed lookup cost neither transaction its own location.
  assert.equal(txRow(a).country, 'GT');
  assert.equal(txRow(b).country, 'GT');

  // Once the queue has drained the slate is clean, and the next sweep asks again.
  assert.ok(owner.state.resets >= 1);
  payeeLocation.state.fail = false;
  await run(b);
  assert.equal(payeeLocation.state.calls.length, 2);
});

test('once a payee turns out to be a physical place abroad, its transactions are located again', async () => {
  trip();
  const imperial = addPayee(replica, 'Imperial Store');
  const earlier = addTx(replica, IMPERIAL, {
    payeeId: imperial,
    categoryId: 'c',
    date: '2026-09-22',
  });
  const id = addTx(replica, IMPERIAL, { payeeId: imperial, categoryId: 'c', date: '2026-09-23' });
  payeeLocation.state.answer = {
    kind: 'local',
    country: 'CR',
    location: 'Juan Santamaría airport',
  };

  await run(id);

  // First looked up with the payee's place unknown: two days before posting, back in Guatemala.
  // Then again once the payee was known to be in Costa Rica.
  assert.deepEqual(
    results(id, 'location').map((r) => (r.data as TxLocation).rule),
    ['posting-lag', 'payee-country'],
  );
  assert.equal(payeeLocation.state.calls[0]!.trigger.ownerCountry, 'GT');
  assert.equal(txRow(id).country, 'CR');
  assert.equal(txRow(id).location, 'Alajuela');
  // The payee's other transaction is redone too, without waiting for its own turn.
  assert.equal(txRow(earlier).country, 'CR');
});

test('a payee re-asked and no longer a physical place has its transactions moved back', async () => {
  trip();
  // Filed as a chain before, so its bill was placed on the last day the owner was in Guatemala.
  const tigo = addPayee(replica, 'Tigo', { locationKind: 'chain', country: 'GT' });
  const opts = { payeeId: tigo, categoryId: 'c', date: '2026-09-18' };
  const id = addTx(replica, 'Tigo Guatemala           GUATE', opts);
  await run(id);
  assert.equal(txRow(id).country, 'GT');

  // Re-asked by hand: the kind is set back to NULL, and this time the answer is remote.
  replica.db.update(payee).set({ locationKind: null }).where(eq(payee.id, tigo)).run();
  payeeLocation.state.answer = { kind: 'remote', country: 'GT', location: null };
  const other = addTx(replica, 'Tigo Guatemala           GUATE', { ...opts, date: '2026-09-19' });
  await run(other);

  assert.equal(txRow(other).country, 'CR');
  assert.equal(txRow(id).country, 'CR', 'the one located under the old kind is redone too');
});

test('a remote payee does not write a second lookup', async () => {
  trip();
  const uber = addPayee(replica, 'Uber');
  const id = addTx(replica, 'UBER *TRIP HELP.UBER.C NL', {
    payeeId: uber,
    categoryId: 'c',
    date: '2026-09-23',
  });
  payeeLocation.state.answer = { kind: 'remote', country: 'US', location: null };

  await run(id);

  assert.equal(results(id, 'location').length, 1);
  assert.equal(txRow(id).country, 'GT');
});

test('a lookup that says nothing new writes nothing', async () => {
  const placed = addPayee(replica, 'La Torre', { locationKind: 'chain', country: 'GT' });
  const id = addTx(replica, LA_TORRE, { payeeId: placed, categoryId: 'c', date: '2026-07-10' });

  await run(id);
  await run(id);
  assert.equal(results(id, 'location').length, 1);

  // The same place, now final, is news: the sweep keeps selecting a transaction until it is.
  owner.state.days.set('2026-07-10', {
    date: '2026-07-10',
    country: 'GT',
    location: 'Guatemala City',
    basis: 'observed',
    confidence: 'high',
    provisional: true,
    resolvedAt: '2026-10-01T00:00:00Z',
  });
  const recent = addTx(replica, LA_TORRE, { payeeId: placed, categoryId: 'c', date: '2026-07-10' });
  await run(recent);
  owner.state.days.delete('2026-07-10');
  await run(recent);
  assert.deepEqual(
    results(recent, 'location').map((r) => (r.data as TxLocation).final),
    [false, true],
  );
});

test('a location failure never costs a transaction its payee', async () => {
  const known = addPayee(replica, 'La Torre', { locationKind: 'chain', country: 'GT' });
  addTx(replica, LA_TORRE, { payeeId: known, categoryId: 'groceries', date: '2026-06-01' });
  const id = addTx(replica, LA_TORRE, { date: '2026-07-10' });
  owner.state.failLocate = true;

  await run(id);

  assert.equal(txRow(id).payeeId, known);
  assert.equal(results(id, 'exact').length, 1);
  assert.equal(txRow(id).country, null);
  assert.equal(results(id, 'location').length, 0, 'nothing terminal is recorded');
});

test('a failed match is still located', async () => {
  const id = addTx(replica, 'NEW MERCHANT             GUATE', { date: '2026-07-10' });
  ai.answer = () => {
    throw new Error('agent returned no structured output');
  };

  await run(id);

  assert.equal(txRow(id).payeeId, null);
  assert.equal(results(id, 'none').length, 0);
  assert.equal(txRow(id).country, 'GT');
});

test('with location switched off, only payee matching runs', async () => {
  owner.state.enabled = false;
  const unplaced = addPayee(replica, 'La Torre');
  addTx(replica, LA_TORRE, { payeeId: unplaced, categoryId: 'groceries', date: '2026-06-01' });
  const id = addTx(replica, LA_TORRE, { date: '2026-07-10' });

  await run(id);

  assert.equal(txRow(id).payeeId, unplaced);
  assert.equal(txRow(id).country, null);
  assert.equal(owner.state.ensured.length, 0);
  assert.equal(payeeLocation.state.calls.length, 0);
});

test('transfers, reconciliation rows and pre-2026 rows are left entirely alone', async () => {
  const ids = [
    addTx(replica, 'TRANSF. PROPIA', { transferBankAccountId: 'acct-2', date: '2026-07-10' }),
    addTx(replica, 'AJUSTE', { reconcile: true, date: '2026-07-10' }),
    addTx(replica, LA_TORRE, { date: '2025-12-31' }),
  ];
  await run(...ids);

  assert.equal(ai.calls, 0);
  assert.equal(owner.state.ensured.length, 0);
  for (const id of ids) {
    assert.equal(txRow(id).country, null);
  }
});

test('sweep: resolves every day the batch needs in one pass before any transaction', async () => {
  const placed = addPayee(replica, 'La Torre', { locationKind: 'chain', country: 'GT' });
  addTx(replica, LA_TORRE, { payeeId: placed, categoryId: 'c', date: '2026-03-10' });
  addTx(replica, LA_TORRE, { payeeId: placed, categoryId: 'c', date: '2026-07-10' });

  resolver.sweep();
  await resolver.queue.onIdle();

  const first = owner.state.ensured[0]!;
  assert.equal(first.length, 20, 'both windows, in the one call');
  assert.ok(first.includes('2026-03-01') && first.includes('2026-07-10'));
  assert.deepEqual(owner.state.places[0], [LA_TORRE, LA_TORRE], 'and every description');

  // Everything is final now, so a second sweep finds nothing to do.
  owner.state.ensured.length = 0;
  resolver.sweep();
  await resolver.queue.onIdle();
  assert.equal(owner.state.ensured.length, 0);
});
