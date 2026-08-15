import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ListenerHeartbeat } from '~/replica-sync/listener-heartbeat';

// The heartbeat is the whole point of the fix, so it is tested in isolation from pg and the DB:
// the probe and the death callback are injected, and intervals are tiny so a test runs in ms.

describe('ListenerHeartbeat', () => {
  it('probes repeatedly while the connection is healthy', async () => {
    let probes = 0;
    const hb = new ListenerHeartbeat({
      intervalMs: 5,
      probeTimeoutMs: 100,
      probe: async () => {
        probes += 1;
      },
      onDead: () => assert.fail('onDead fired on a healthy connection'),
    });
    hb.start();
    await delay(40);
    hb.stop();
    assert.ok(probes >= 3, `expected several probes, got ${probes}`);
  });

  it('reports death once when a probe rejects, and stops probing', async () => {
    let deaths = 0;
    let deadErr: Error | undefined;
    let probesAfterDeath = 0;
    let dead = false;
    const hb = new ListenerHeartbeat({
      intervalMs: 5,
      probeTimeoutMs: 100,
      probe: async () => {
        if (dead) {
          probesAfterDeath += 1;
        }
        throw new Error('connection terminated unexpectedly');
      },
      onDead: (err) => {
        deaths += 1;
        deadErr = err;
        dead = true;
      },
    });
    hb.start();
    await delay(40);
    assert.equal(deaths, 1, 'onDead must fire exactly once');
    assert.match(deadErr?.message ?? '', /terminated/);
    assert.equal(probesAfterDeath, 0, 'kept probing after reporting death');
  });

  it('treats a probe that never settles as death', async () => {
    let deaths = 0;
    let deadErr: Error | undefined;
    const hb = new ListenerHeartbeat({
      intervalMs: 5,
      probeTimeoutMs: 20,
      // A silently-dropped socket: the query neither resolves nor rejects. This is the case a plain
      // rejection test would miss, and the one that actually happened against the pooler.
      probe: () => new Promise<void>(() => {}),
      onDead: (err) => {
        deaths += 1;
        deadErr = err;
      },
    });
    hb.start();
    await delay(80);
    hb.stop();
    assert.equal(deaths, 1, 'a hung probe must be treated as death');
    assert.match(deadErr?.message ?? '', /timed out/);
  });

  it('stop() before the first probe means no probe and no death', async () => {
    let probes = 0;
    let deaths = 0;
    const hb = new ListenerHeartbeat({
      intervalMs: 15,
      probeTimeoutMs: 100,
      probe: async () => {
        probes += 1;
      },
      onDead: () => {
        deaths += 1;
      },
    });
    hb.start();
    hb.stop();
    await delay(40);
    assert.equal(probes, 0);
    assert.equal(deaths, 0);
  });
});
