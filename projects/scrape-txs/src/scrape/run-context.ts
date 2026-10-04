import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogMixin } from '@rhyek/nestjs-utils';

/** The run a piece of code is executing for. Set once around a bank's scrape job. */
export const runContext = new AsyncLocalStorage<{ runId: string; bankKey: string }>();

/** Puts `run: { runId, bankKey }` on every line logged inside a run — the bank flows included. */
export const runMixin: LogMixin = () => {
  const run = runContext.getStore();
  return run ? ['run', run] : undefined;
};
