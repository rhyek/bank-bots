import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { eq } from 'drizzle-orm';
import {
  PayeeLocationMatcher,
  checkPayeeLocation,
  type PayeeLocationAnswer,
  type PayeeLocationInput,
} from '~/payee-location/payee-location-matcher';
import { PayeeLocationService } from '~/payee-location/payee-location.service';
import type { PayeeLocationWriter } from '~/payee-location/payee-location-writer';
import { payee } from '~/replica-db/replica-schema';
import type { ReplicaDb } from '~/replica-db/replica-db.service';
import { addPayee, addTx, makeReplica } from '~/testing/replica';

const answer = (over: Partial<PayeeLocationAnswer>): PayeeLocationAnswer => ({
  kind: 'chain',
  country: 'GT',
  location: null,
  confidence: 'high',
  summary: 'several branches in Guatemala',
  ...over,
});

class StubMatcher extends PayeeLocationMatcher {
  inputs: PayeeLocationInput[] = [];
  answer: PayeeLocationAnswer = answer({});
  match(input: PayeeLocationInput): Promise<PayeeLocationAnswer> {
    this.inputs.push(input);
    return Promise.resolve(this.answer);
  }
}

/** The writer with Postgres and replication collapsed: the payee row changes at once. */
function fakeWriter(replica: ReplicaDb) {
  const recorded: { payeeId: string; answer: PayeeLocationAnswer; triggerTxId: string }[] = [];
  const writer = {
    async record(payeeId: string, a: PayeeLocationAnswer, triggerTxId: string) {
      recorded.push({ payeeId, answer: a, triggerTxId });
      replica.db
        .update(payee)
        .set({ locationKind: a.kind, country: a.country, location: a.location })
        .where(eq(payee.id, payeeId))
        .run();
    },
  } as unknown as PayeeLocationWriter;
  return { writer, recorded };
}

let replica: ReplicaDb;
let matcher: StubMatcher;
let recorded: ReturnType<typeof fakeWriter>['recorded'];
let service: PayeeLocationService;

beforeEach(() => {
  replica = makeReplica();
  matcher = new StubMatcher();
  const fake = fakeWriter(replica);
  recorded = fake.recorded;
  service = new PayeeLocationService(replica, matcher, fake.writer, new StructuredLoggerService());
});

const trigger = (txId: string) => ({
  txId,
  date: '2026-07-10',
  description: 'LA TORRE ZONA 14         GUATE',
  ownerCountry: 'GT',
  ownerLocation: 'Guatemala City',
});

test('resolve: asks the matcher and records its answer against the payee', async () => {
  const id = addPayee(replica, 'La Torre');
  const tx = addTx(replica, 'LA TORRE ZONA 14         GUATE', { payeeId: id, date: '2026-07-10' });

  const out = await service.resolve(id, trigger(tx));

  assert.equal(out!.kind, 'chain');
  assert.deepEqual(recorded, [{ payeeId: id, answer: answer({}), triggerTxId: tx }]);
});

test('resolve: only for a payee whose kind is NULL — "unknown" is an answer too', async () => {
  for (const locationKind of ['local', 'chain', 'remote', 'unknown']) {
    const id = addPayee(replica, `Payee ${locationKind}`, { locationKind });
    assert.equal(await service.resolve(id, trigger('tx')), null);
  }
  assert.equal(await service.resolve('no-such-payee', trigger('tx')), null);
  assert.equal(matcher.inputs.length, 0);

  // And once answered, the same payee is not asked about twice.
  const id = addPayee(replica, 'Juan Pérez');
  matcher.answer = answer({ kind: 'unknown', country: null });
  await service.resolve(id, trigger('tx'));
  await service.resolve(id, trigger('tx'));
  assert.equal(matcher.inputs.length, 1);
});

test("resolve: shows the matcher the payee's statement lines and how their place fields spread", async () => {
  const id = addPayee(replica, 'La Torre');
  addTx(replica, 'LA TORRE ZONA 14         GUATE', { payeeId: id, date: '2026-03-01' });
  addTx(replica, 'LA TORRE ZONA 14         GUATE', { payeeId: id, date: '2026-07-10' });
  addTx(replica, 'LA TORRE ANTIGUA         ANTIG', {
    payeeId: id,
    date: '2026-05-05',
    amountCents: -2500,
  });
  addTx(replica, 'LATORRE.COM.GT PEDIDO  GT', { payeeId: id, date: '2026-04-04' });
  addTx(replica, 'LA TORRE EN LINEA', { payeeId: id, date: '2026-02-02' });
  addTx(replica, 'SOMEONE ELSE             GUATE', { date: '2026-07-11' });

  await service.resolve(id, trigger('tx'));

  const input = matcher.inputs[0]!;
  assert.equal(input.name, 'La Torre');
  assert.equal(input.txCount, 5);
  assert.equal(input.firstDate, '2026-02-02');
  assert.equal(input.lastDate, '2026-07-10');
  assert.deepEqual(input.placeFields, [
    { field: 'city "GUATE"', count: 2 },
    { field: 'city "ANTIG"', count: 1 },
    { field: 'country "GT"', count: 1 },
    { field: 'no place field', count: 1 },
  ]);
  assert.deepEqual(
    input.samples.map((s) => s.date),
    ['2026-07-10', '2026-05-05', '2026-04-04', '2026-03-01', '2026-02-02'],
  );
  assert.deepEqual(input.trigger, {
    date: '2026-07-10',
    description: 'LA TORRE ZONA 14         GUATE',
    ownerCountry: 'GT',
    ownerLocation: 'Guatemala City',
  });
});

test('resolve: at most ten samples, and a distinct description beats a repeat', async () => {
  const id = addPayee(replica, 'La Torre');
  for (let day = 1; day <= 12; day += 1) {
    addTx(replica, 'LA TORRE ZONA 14         GUATE', {
      payeeId: id,
      date: `2026-07-${String(day).padStart(2, '0')}`,
    });
  }
  addTx(replica, 'LA TORRE ANTIGUA         ANTIG', { payeeId: id, date: '2026-01-15' });

  await service.resolve(id, trigger('tx'));

  const { samples } = matcher.inputs[0]!;
  assert.equal(samples.length, 10);
  // The oldest line of all is kept, because it is the only one from that branch.
  assert.equal(samples.at(-1)!.description, 'LA TORRE ANTIGUA         ANTIG');
});

test('resolve: an answer that contradicts its own kind is a failed run and records nothing', async () => {
  const id = addPayee(replica, 'Imperial Store');
  for (const bad of [
    answer({ kind: 'local', country: 'CR', location: null }),
    answer({ kind: 'local', country: null, location: 'Zona 10' }),
    answer({ kind: 'chain', country: 'Guatemala' }),
    answer({ kind: 'remote', country: 'XX' }),
  ]) {
    matcher.answer = bad;
    await assert.rejects(service.resolve(id, trigger('tx')));
  }
  assert.equal(recorded.length, 0);
});

test('checkPayeeLocation: keeps what the kind uses and drops what it does not', () => {
  assert.deepEqual(
    checkPayeeLocation(answer({ kind: 'local', country: ' cr ', location: ' Las Catalinas ' })),
    answer({ kind: 'local', country: 'CR', location: 'Las Catalinas' }),
  );
  // A head-office city for a chain or a remote brand is not a location the model stores.
  assert.equal(checkPayeeLocation(answer({ kind: 'chain', location: 'Zona 10' })).location, null);
  // A chain may have no country (a brand with branches in many), and so may a remote payee whose
  // company could not be placed.
  for (const kind of ['chain', 'remote'] as const) {
    assert.deepEqual(
      checkPayeeLocation(answer({ kind, country: null })),
      answer({ kind, country: null }),
    );
  }
  assert.equal(
    checkPayeeLocation(answer({ kind: 'remote', country: 'US', location: 'Seattle' })).location,
    null,
  );
  assert.deepEqual(
    checkPayeeLocation(answer({ kind: 'unknown', country: 'GT', location: 'somewhere' })),
    answer({ kind: 'unknown', country: null, location: null }),
  );
});
