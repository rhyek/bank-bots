import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { uuidv7 } from '@bank-bots/db';
import { BankConfigService } from '~/bank-config/bank-config.service';
import type { BankKey } from '~/bank-config/bank-keys';
import type { Config } from '~/bank-config/config-schema';
import {
  BankCredentialsService,
  type CredentialsResult,
} from '~/credentials/bank-credentials.service';
import { lastFullSuccessAt, monthsSince } from './months';
import { runContext } from './run-context';
import { ScrapeAlertService } from './scrape-alert.service';
import { ScrapeFailure, ScrapeJobService } from './scrape-job.service';
import { ScrapeRunStore } from './scrape-run.store';
import type { Run, RunError, RunResult, RunStage, RunTrigger } from './scrape.dto';

export type BatchRequest = {
  bankKey: BankKey;
  params: { months?: string[]; account?: string; dryRun?: boolean };
};

export type Batch = {
  started: Run[];
  /** Requests not started because their bank already has a run in progress: those runs. */
  alreadyRunning: Run[];
  /** Settles when every started run has ended. Never rejects. */
  done: Promise<void>;
};

const LIST_LIMIT = 50;

/**
 * Starts scrapes, in batches: the scheduled tick is a batch of three, a manual call a batch of one.
 * A batch stores its runs, fetches the credentials of all its banks in one Bitwarden session, then
 * forks into one job per bank. Runs end independently — a failure never leaves its own run.
 */
@Injectable()
export class ScrapeRunsService implements OnApplicationBootstrap {
  /** The bank lock: one run per bank at a time, whoever asked for it. */
  private readonly running = new Map<BankKey, Run>();

  constructor(
    private readonly store: ScrapeRunStore,
    private readonly bankConfig: BankConfigService,
    private readonly credentials: BankCredentialsService,
    private readonly job: ScrapeJobService,
    private readonly alerts: ScrapeAlertService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const count = await this.store.failInterrupted(
      new Date().toISOString(),
      'interrupted: the service stopped before this run finished',
    );
    if (count > 0) {
      this.logger.warn({ count }, 'failed the runs a stopped process left running');
    }
  }

  get(runId: string): Promise<Run | undefined> {
    return this.store.get(runId);
  }

  list(): Promise<Run[]> {
    return this.store.list(LIST_LIMIT);
  }

  async startBatch(
    requests: BatchRequest[],
    trigger: RunTrigger,
    now: Date = new Date(),
  ): Promise<Batch> {
    const started: Run[] = [];
    const alreadyRunning: Run[] = [];
    const monthsRequested = new Set<Run>();
    const skippedMonths = new Map<Run, string[]>();

    // Locks are taken before the first await, so two overlapping calls cannot both start a bank.
    for (const { bankKey, params } of requests) {
      const current = this.running.get(bankKey);
      if (current) {
        alreadyRunning.push(current);
        continue;
      }
      const run: Run = {
        runId: uuidv7(),
        bankKey,
        trigger,
        status: 'running',
        startedAt: now.toISOString(),
        finishedAt: null,
        params: {
          months: params.months ?? [],
          ...(params.account ? { account: params.account } : {}),
          dryRun: params.dryRun ?? false,
        },
        result: null,
        error: null,
      };
      if (params.months) {
        monthsRequested.add(run);
      }
      this.running.set(bankKey, run);
      started.push(run);
    }

    const stored: Run[] = [];
    try {
      for (const run of started) {
        if (!monthsRequested.has(run)) {
          const history = await this.store.succeededFullRuns(run.bankKey);
          const { months, skipped } = monthsSince(
            lastFullSuccessAt(
              history.map((r) => ({ startedAt: r.startedAt, months: r.params.months })),
            ),
            now,
          );
          run.params.months = months;
          if (skipped.length > 0) {
            skippedMonths.set(run, skipped);
          }
        }
        await this.store.insert(run);
        stored.push(run);
      }
    } catch (error) {
      // Nothing of this batch runs. Free the banks, and do not leave a stored run "running".
      for (const run of started) {
        this.running.delete(run.bankKey);
      }
      const finishedAt = new Date().toISOString();
      const message = `not started: ${(error as Error).message}`;
      await Promise.allSettled(
        stored.map((run) =>
          this.store.finish(run.runId, {
            status: 'failed',
            finishedAt,
            result: null,
            error: { message, stage: 'config' },
          }),
        ),
      );
      throw error;
    }

    for (const run of started) {
      this.logger.info(
        { runId: run.runId, bankKey: run.bankKey, trigger, params: run.params },
        'scrape run started',
      );
    }
    // A gap longer than a run reaches on its own: say so, or those months are silently never scraped.
    for (const [run, skipped] of skippedMonths) {
      this.logger.warn(
        { runId: run.runId, bankKey: run.bankKey, skipped },
        'months since the last successful scrape are beyond the automatic reach; not scraped',
      );
      void this.alerts.monthsSkipped(run, skipped).catch((alertError: unknown) => {
        this.logger.error(
          { error: toError(alertError) },
          'could not send the skipped-months alert',
        );
      });
    }
    // The terminal catch matters: this promise is not awaited by the caller, and an unhandled
    // rejection would take the process — and every other run — down.
    const done = this.runBatch(started).catch((error: unknown) => {
      this.logger.error({ error: toError(error) }, 'scrape batch crashed');
    });
    return { started, alreadyRunning, done };
  }

  private async runBatch(runs: Run[]): Promise<void> {
    if (runs.length === 0) {
      return;
    }
    let config: Config;
    try {
      config = await this.bankConfig.load();
    } catch (error) {
      await this.failBatch(runs, 'config', toError(error));
      return;
    }

    const runnable: Run[] = [];
    for (const run of runs) {
      const { account } = run.params;
      if (account && !config.banks[run.bankKey].accounts.some((a) => a.number === account)) {
        await this.fail(
          run,
          new ScrapeFailure('config', `Account ${account} is not one of ${run.bankKey}'s accounts`),
        );
      } else {
        runnable.push(run);
      }
    }
    if (runnable.length === 0) {
      return;
    }

    let credentials: Map<BankKey, CredentialsResult>;
    try {
      credentials = await this.credentials.fetch(
        runnable.map((r) => r.bankKey),
        config,
      );
    } catch (error) {
      await this.failBatch(runnable, 'credentials', toError(error));
      return;
    }
    const first = credentials.get(runnable[0]!.bankKey);
    if (first && !first.ok && first.scope === 'session') {
      // Bitwarden itself failed: every run of the batch failed for this one reason.
      await this.failBatch(runnable, 'credentials', first.error);
      return;
    }

    await Promise.allSettled(
      runnable.map((run) => this.runOne(run, credentials.get(run.bankKey), config)),
    );
  }

  private async runOne(
    run: Run,
    credentials: CredentialsResult | undefined,
    config: Config,
  ): Promise<void> {
    try {
      if (!credentials?.ok) {
        throw new ScrapeFailure(
          'credentials',
          credentials?.error.message ?? `no credentials were returned for ${run.bankKey}`,
        );
      }
      const result = await runContext.run({ runId: run.runId, bankKey: run.bankKey }, () =>
        this.job.run({
          runId: run.runId,
          bankKey: run.bankKey,
          params: run.params,
          credentials: credentials.credentials,
          config,
        }),
      );
      await this.finish(run, { status: 'succeeded', result, error: null });
    } catch (error) {
      await this.fail(run, error);
    }
  }

  /** Ends a run as failed and alerts the owner about it. */
  private async fail(run: Run, error: unknown): Promise<void> {
    await this.finish(run, { status: 'failed', result: null, error: toRunError(error) }, error);
    try {
      await this.alerts.runFailed(run);
    } catch (alertError) {
      this.logger.error(
        { error: toError(alertError), runId: run.runId, bankKey: run.bankKey },
        'could not send the failure alert',
      );
    }
  }

  /** Ends every run of a batch for one shared reason, with a single alert. */
  private async failBatch(runs: Run[], stage: RunStage, error: Error): Promise<void> {
    for (const run of runs) {
      await this.finish(
        run,
        { status: 'failed', result: null, error: { message: error.message, stage } },
        error,
      );
    }
    try {
      await this.alerts.batchFailed(runs, error);
    } catch (alertError) {
      this.logger.error({ error: toError(alertError) }, 'could not send the failure alert');
    }
  }

  private async finish(
    run: Run,
    end: { status: 'succeeded' | 'failed'; result: RunResult | null; error: RunError | null },
    cause?: unknown,
  ): Promise<void> {
    Object.assign(run, end, { finishedAt: new Date().toISOString() });
    // Released first: the bank must be scrapable again even if the row below cannot be written.
    this.running.delete(run.bankKey);

    const attributes = { runId: run.runId, bankKey: run.bankKey, trigger: run.trigger };
    if (run.status === 'succeeded') {
      this.logger.info({ ...attributes, result: run.result }, 'scrape run succeeded');
    } else {
      this.logger.error(
        { ...attributes, error: toError(cause), stage: run.error?.stage },
        'scrape run failed',
      );
    }
    try {
      await this.store.finish(run.runId, {
        status: run.status,
        finishedAt: run.finishedAt,
        result: run.result,
        error: run.error,
      });
    } catch (storeError) {
      this.logger.error(
        { ...attributes, error: toError(storeError) },
        'could not store the end of the run',
      );
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toRunError(error: unknown): RunError {
  if (error instanceof ScrapeFailure) {
    return {
      message: error.message,
      stage: error.stage,
      ...(error.tracePath ? { tracePath: error.tracePath } : {}),
    };
  }
  // Anything a job throws that it did not classify happened while scraping.
  return { message: toError(error).message, stage: 'scrape' };
}
