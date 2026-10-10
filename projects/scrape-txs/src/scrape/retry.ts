import { setTimeout as sleepFor } from 'node:timers/promises';

/**
 * Runs `run` until it succeeds, at most `attempts` times, pausing `backoffMs` before each retry.
 * The pause is what keeps a retry from hitting a bank that just refused the machine in the same
 * second. The last attempt's error is the one thrown.
 */
export async function withRetries<T>(
  opts: {
    attempts: number;
    backoffMs: number;
    /** Called for a failed attempt that will be retried, before the pause. */
    onRetry?: (attempt: number, error: unknown) => void;
    sleep?: (ms: number) => Promise<unknown>;
  },
  run: (attempt: number, last: boolean) => Promise<T>,
): Promise<T> {
  const sleep = opts.sleep ?? sleepFor;
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= opts.attempts;
    try {
      return await run(attempt, last);
    } catch (error) {
      if (last) {
        throw error;
      }
      opts.onRetry?.(attempt, error);
      await sleep(opts.backoffMs);
    }
  }
}
