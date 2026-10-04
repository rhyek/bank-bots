import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { AppEvents } from '~/events/app-events';
import { ReplicaSettled } from '~/events/replica-settled.service';

// A replica that never has the row, so the safety-net poll never fires and each test exercises the
// path it means to (event, non-match, timeout, registration order).
function makeAbsentReplica() {
  return {
    raw: { prepare: () => ({ get: () => undefined }) },
  } as unknown as ConstructorParameters<typeof ReplicaSettled>[1];
}

function make() {
  const events = new AppEvents();
  return {
    events,
    settled: new ReplicaSettled(events, makeAbsentReplica(), new StructuredLoggerService()),
  };
}

describe('ReplicaSettled', () => {
  afterEach(() => {
    delete process.env.TX_AI_SETTLE_TIMEOUT_MS;
  });

  it('resolves once the matching row is persisted', async () => {
    const { events, settled } = make();
    const out = await settled.around('payee', 'p1', async () => {
      setTimeout(
        () =>
          void events.emit('replica-sync.row-persisted', {
            table: 'payee',
            op: 'insert',
            id: 'p1',
          }),
        5,
      );
      return 'written';
    });
    assert.equal(out, 'written');
  });

  it('ignores events for a different id or table', async () => {
    process.env.TX_AI_SETTLE_TIMEOUT_MS = '150';
    const { events, settled } = make();
    let resolved = false;

    const pending = settled
      .around('payee', 'p1', async () => 'written')
      .then(() => {
        resolved = true;
      });

    // Neither of these should release the barrier: right table wrong id, then right id wrong table.
    await events.emit('replica-sync.row-persisted', { table: 'payee', op: 'insert', id: 'p2' });
    await events.emit('replica-sync.row-persisted', { table: 'category', op: 'insert', id: 'p1' });
    assert.equal(resolved, false, 'barrier released by a non-matching event');

    await pending; // only the timeout can release it
    assert.equal(resolved, true);
  });

  // The barrier guards work that has already been committed to Postgres, so a lost notification must
  // degrade to "carry on" and never fail the caller.
  it('resolves on timeout instead of throwing', async () => {
    process.env.TX_AI_SETTLE_TIMEOUT_MS = '50';
    const { settled } = make();
    const started = Date.now();
    const out = await settled.around('payee', 'never', async () => 'written');
    assert.equal(out, 'written');
    assert.ok(Date.now() - started >= 45, 'returned before the timeout elapsed');
  });

  // The ordering guarantee: emitting synchronously from inside the write callback still has to be
  // observed. If the listener were registered after the write, this would hang until the timeout.
  it('registers its listener before running the write', async () => {
    process.env.TX_AI_SETTLE_TIMEOUT_MS = '10000';
    const { events, settled } = make();
    const started = Date.now();
    const out = await settled.around('matching_rule', 'r1', async () => {
      await events.emit('replica-sync.row-persisted', {
        table: 'matching_rule',
        op: 'insert',
        id: 'r1',
      });
      return 'written';
    });
    assert.equal(out, 'written');
    assert.ok(
      Date.now() - started < 1000,
      'fell through to the timeout — listener registered late',
    );
  });

  it('releases the listener afterwards', async () => {
    const { events, settled } = make();
    await settled.around('payee', 'p1', async () => {
      setTimeout(
        () =>
          void events.emit('replica-sync.row-persisted', {
            table: 'payee',
            op: 'insert',
            id: 'p1',
          }),
        1,
      );
      return null;
    });
    assert.equal(events.listenerCount('replica-sync.row-persisted'), 0);
  });
});
