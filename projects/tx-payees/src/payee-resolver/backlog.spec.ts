import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { ReplicaDb } from '~/replica-db/replica-db.service';
import { hasNoneVerdict, lastLocation, selectBacklog } from '~/payee-resolver/backlog';
import { addPayee, addResult, addTx, makeReplica } from '~/testing/replica';

const FROM = '2026-01-01';
const FINAL = {
  purchaseDate: '2026-06-29',
  rule: 'single-country',
  country: 'GT',
  location: null,
  final: true,
};

let replica: ReplicaDb;
let placed: string;

beforeEach(() => {
  replica = makeReplica();
  placed = addPayee(replica, 'La Torre', { locationKind: 'chain', country: 'GT' });
});

const ids = (withLocation = true) => selectBacklog(replica, FROM, withLocation).map((r) => r.id);

/** A transaction with nothing left to do: a placed payee and a final location. */
function done(description = 'LA TORRE ZONA 14         GUATE') {
  const id = addTx(replica, description, { payeeId: placed, categoryId: 'c1' });
  addResult(replica, id, 'location', FINAL);
  return id;
}

test('selectBacklog: a transaction with a placed payee and a final location is left alone', () => {
  done();
  assert.deepEqual(ids(), []);
});

test('selectBacklog reason 1: no payee', () => {
  const id = addTx(replica, 'NEW MERCHANT             GUATE');
  addResult(replica, id, 'location', FINAL);
  assert.deepEqual(ids(), [id]);
});

test('selectBacklog reason 1: not when the AI tier already gave up on it', () => {
  const id = addTx(replica, 'TF: ACH INMEDIATO 9004228');
  addResult(replica, id, 'none');
  addResult(replica, id, 'location', FINAL);
  assert.deepEqual(ids(), []);
});

test('selectBacklog reason 2: no location lookup, or only a provisional one', () => {
  const never = addTx(replica, 'A', { payeeId: placed, categoryId: 'c1' });
  const provisional = addTx(replica, 'B', { payeeId: placed, categoryId: 'c1' });
  addResult(replica, provisional, 'location', { ...FINAL, final: false });
  // A payee verdict is not a location lookup.
  const matchedOnly = addTx(replica, 'C', { payeeId: placed, categoryId: 'c1' });
  addResult(replica, matchedOnly, 'exact');
  assert.deepEqual(ids(), [never, provisional, matchedOnly]);
});

test('selectBacklog reason 2: a final lookup excludes it, even after provisional ones', () => {
  const id = addTx(replica, 'A', { payeeId: placed, categoryId: 'c1' });
  addResult(replica, id, 'location', { ...FINAL, final: false });
  addResult(replica, id, 'location', FINAL);
  assert.deepEqual(ids(), []);
});

test('selectBacklog reason 2: a gave-up transaction is still picked up to be located', () => {
  const id = addTx(replica, 'TF: ACH INMEDIATO 9004228');
  addResult(replica, id, 'none');
  assert.deepEqual(ids(), [id]);
});

test('selectBacklog reason 3: its payee has no location kind yet', () => {
  const unplaced = addPayee(replica, 'Imperial Store');
  const id = addTx(replica, 'IMPERIAL STORE           ALAJU', {
    payeeId: unplaced,
    categoryId: 'c1',
  });
  addResult(replica, id, 'location', FINAL);
  assert.deepEqual(ids(), [id]);

  // 'unknown' is a kind: looked up, and not asked again.
  const unknown = addPayee(replica, 'Juan Pérez', { locationKind: 'unknown' });
  const other = addTx(replica, 'ACH DE JUAN PEREZ', { payeeId: unknown, categoryId: 'c1' });
  addResult(replica, other, 'location', FINAL);
  assert.deepEqual(ids(), [id]);
});

test('selectBacklog: with location off, only transactions without a payee', () => {
  const unmapped = addTx(replica, 'NEW MERCHANT             GUATE');
  addTx(replica, 'A', { payeeId: placed, categoryId: 'c1' });
  const gaveUp = addTx(replica, 'TF: ACH INMEDIATO 9004228');
  addResult(replica, gaveUp, 'none');
  assert.deepEqual(ids(false), [unmapped]);
});

test('selectBacklog: never transfers, reconciliation rows, or anything before the start date', () => {
  addTx(replica, 'TRANSF. PROPIA', { transferBankAccountId: 'acct-2' });
  addTx(replica, 'AJUSTE', { reconcile: true });
  addTx(replica, 'OLD MERCHANT             GUATE', { date: '2025-12-31' });
  assert.deepEqual(ids(), []);
});

test('selectBacklog: oldest-created first, ids breaking ties', () => {
  const late = addTx(replica, 'A', { createdAt: '2026-08-01T00:00:00Z' });
  const first = addTx(replica, 'B', { createdAt: '2026-07-01T00:00:00Z' });
  const second = addTx(replica, 'C', { createdAt: '2026-07-01T00:00:00Z' });
  assert.deepEqual(ids(), [first, second, late]);
});

test('hasNoneVerdict and lastLocation: read the audit log by type', () => {
  const id = addTx(replica, 'A');
  assert.equal(hasNoneVerdict(replica, id), false);
  assert.equal(lastLocation(replica, id), null);

  addResult(replica, id, 'none');
  addResult(replica, id, 'location', { ...FINAL, final: false });
  addResult(replica, id, 'location', FINAL);
  assert.equal(hasNoneVerdict(replica, id), true);
  assert.deepEqual(lastLocation(replica, id), FINAL);
});
