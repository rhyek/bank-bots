import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRetries } from './retry';

function setup(outcomes: (string | Error)[]) {
  const events: string[] = [];
  const result = withRetries(
    {
      attempts: 2,
      backoffMs: 5000,
      sleep: async (ms) => {
        events.push(`sleep ${ms}`);
      },
      onRetry: (attempt, error) => {
        events.push(`retrying after ${attempt}: ${(error as Error).message}`);
      },
    },
    async (attempt, last) => {
      events.push(`attempt ${attempt}${last ? ' (last)' : ''}`);
      const outcome = outcomes[attempt - 1]!;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    },
  );
  return { events, result };
}

test('a first attempt that succeeds is not followed by a pause or a retry', async () => {
  const { events, result } = setup(['rows']);

  assert.equal(await result, 'rows');
  assert.deepEqual(events, ['attempt 1']);
});

test('a failed attempt is retried only after the backoff', async () => {
  const { events, result } = setup([new Error('access denied'), 'rows']);

  assert.equal(await result, 'rows');
  assert.deepEqual(events, [
    'attempt 1',
    'retrying after 1: access denied',
    'sleep 5000',
    'attempt 2 (last)',
  ]);
});

test("the last attempt's error is thrown, with no pause after it", async () => {
  const { events, result } = setup([new Error('first'), new Error('second')]);

  await assert.rejects(result, { message: 'second' });
  assert.deepEqual(events, [
    'attempt 1',
    'retrying after 1: first',
    'sleep 5000',
    'attempt 2 (last)',
  ]);
});
