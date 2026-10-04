import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import type { BankKey } from '~/bank-config/bank-keys';
import type { Config } from '~/bank-config/config-schema';
import { AccountType } from '~/bank-config/types';
import type { BankConfigService } from '~/bank-config/bank-config.service';
import type {
  BankCredentialsService,
  CredentialsResult,
} from '~/credentials/bank-credentials.service';
import type { ScrapeAlertService } from './scrape-alert.service';
import { ScrapeFailure, type ScrapeJobInput, type ScrapeJobService } from './scrape-job.service';
import type { ScrapeRunStore } from './scrape-run.store';
import { ScrapeRunsService } from './scrape-runs.service';
import type { Run, RunResult } from './scrape.dto';

const config: Config = {
  banks: {
    bancoIndustrialGt: {
      bitwardenItemId: 'item-bi',
      accounts: [{ type: AccountType.Checking, number: '111' }],
    },
    bacGt: {
      bitwardenItemId: 'item-gt',
      country: 'Guatemala',
      accounts: [{ type: 'checking', number: '222' }],
    },
    bacCr: {
      bitwardenItemId: 'item-cr',
      country: 'Costa Rica',
      accounts: [{ type: 'checking', number: '333' }],
    },
  },
};

const ALL: BankKey[] = ['bancoIndustrialGt', 'bacGt', 'bacCr'];
const okResult: RunResult = { upserted: 3, deleted: 0, balancesUpdated: 1 };
const creds = { username: 'u', password: 'p' };

type JobBehavior = (input: ScrapeJobInput) => Promise<RunResult>;

/** The `scrape_run` table, in memory. */
function fakeStore(seed: Run[] = []) {
  const rows = new Map(seed.map((r) => [r.runId, r]));
  const newestFirst = () =>
    [...rows.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const store: ScrapeRunStore & { rows: Map<string, Run>; failInsert?: boolean } = {
    rows,
    async insert(run) {
      if (store.failInsert) {
        throw new Error('database is down');
      }
      rows.set(run.runId, structuredClone(run));
    },
    async finish(runId, patch) {
      rows.set(runId, { ...rows.get(runId)!, ...patch });
    },
    get: async (runId) => rows.get(runId),
    list: async (limit) => newestFirst().slice(0, limit),
    succeededFullRuns: async (bankKey) =>
      newestFirst().filter(
        (r) =>
          r.bankKey === bankKey &&
          r.status === 'succeeded' &&
          !r.params.dryRun &&
          r.params.account === undefined,
      ),
    async failInterrupted(finishedAt, message) {
      let n = 0;
      for (const r of rows.values()) {
        if (r.status === 'running') {
          rows.set(r.runId, {
            ...r,
            status: 'failed',
            finishedAt,
            error: { message, stage: 'scrape' },
          });
          n++;
        }
      }
      return n;
    },
  };
  return store;
}

const pastRun = (over: Partial<Run> & Pick<Run, 'runId' | 'bankKey' | 'startedAt'>): Run => ({
  trigger: 'schedule',
  status: 'succeeded',
  finishedAt: over.startedAt,
  params: { months: [], dryRun: false },
  result: okResult,
  error: null,
  ...over,
});

function setup(
  opts: {
    seed?: Run[];
    job?: Partial<Record<BankKey, JobBehavior>>;
    credentials?: (bankKeys: BankKey[]) => Map<BankKey, CredentialsResult>;
    loadConfig?: () => Promise<Config>;
    alertThrows?: boolean;
  } = {},
) {
  const seen = {
    credentialCalls: [] as BankKey[][],
    jobCalls: [] as ScrapeJobInput[],
    runAlerts: [] as Run[],
    batchAlerts: [] as { runs: Run[]; error: Error }[],
    skippedAlerts: [] as { bankKey: BankKey; skipped: string[] }[],
  };
  const store = fakeStore(opts.seed);
  const service = new ScrapeRunsService(
    store,
    { load: opts.loadConfig ?? (async () => config) } as unknown as BankConfigService,
    {
      fetch: async (bankKeys: BankKey[]) => {
        seen.credentialCalls.push(bankKeys);
        return (
          opts.credentials?.(bankKeys) ??
          new Map(bankKeys.map((k) => [k, { ok: true, credentials: creds }]))
        );
      },
    } as unknown as BankCredentialsService,
    {
      run: async (input: ScrapeJobInput) => {
        seen.jobCalls.push(input);
        return (await opts.job?.[input.bankKey]?.(input)) ?? okResult;
      },
    } as unknown as ScrapeJobService,
    {
      runFailed: async (run: Run) => {
        if (opts.alertThrows) {
          throw new Error('smtp down');
        }
        seen.runAlerts.push(run);
      },
      batchFailed: async (runs: Run[], error: Error) => {
        seen.batchAlerts.push({ runs, error });
      },
      monthsSkipped: async (run: Run, skipped: string[]) => {
        seen.skippedAlerts.push({ bankKey: run.bankKey, skipped });
      },
    } as unknown as ScrapeAlertService,
    new StructuredLoggerService(),
  );
  const requests = (bankKeys: BankKey[]) => bankKeys.map((bankKey) => ({ bankKey, params: {} }));
  return { service, seen, requests, store };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('a batch stores one running run per bank and returns before any scrape ends', async () => {
  const { service, requests, store } = setup();
  const { started, alreadyRunning } = await service.startBatch(requests(ALL), 'schedule');

  assert.deepEqual(
    started.map((r) => [r.bankKey, r.status, r.trigger]),
    ALL.map((k) => [k, 'running', 'schedule']),
  );
  assert.deepEqual(alreadyRunning, []);
  assert.deepEqual([...store.rows.keys()].sort(), started.map((r) => r.runId).sort());
});

test('one bank failing leaves the other two succeeded', async () => {
  const { service, requests, store } = setup({
    job: {
      bacGt: async () => {
        throw new ScrapeFailure('scrape', 'login button not found', {
          tracePath: '/runs/x/trace.zip',
        });
      },
    },
  });
  const { started, done } = await service.startBatch(requests(ALL), 'schedule');
  await done;

  const byBank = Object.fromEntries(started.map((r) => [r.bankKey, store.rows.get(r.runId)!]));
  assert.equal(byBank.bancoIndustrialGt!.status, 'succeeded');
  assert.equal(byBank.bacCr!.status, 'succeeded');
  assert.deepEqual(byBank.bacCr!.result, okResult);
  assert.equal(byBank.bacGt!.status, 'failed');
  assert.deepEqual(byBank.bacGt!.error, {
    message: 'login button not found',
    stage: 'scrape',
    tracePath: '/runs/x/trace.zip',
  });
  assert.notEqual(byBank.bacGt!.finishedAt, null);
});

test('a failed run sends one alert, for that run only', async () => {
  const { service, seen, requests } = setup({
    job: {
      bacGt: async () => {
        throw new Error('boom');
      },
    },
  });
  await (
    await service.startBatch(requests(ALL), 'schedule')
  ).done;

  assert.deepEqual(
    seen.runAlerts.map((r) => [r.bankKey, r.status, r.error?.stage]),
    [['bacGt', 'failed', 'scrape']],
  );
  assert.deepEqual(seen.batchAlerts, []);
});

test('credentials are fetched once per batch, for all of its banks', async () => {
  const { service, seen, requests } = setup();
  await (
    await service.startBatch(requests(ALL), 'schedule')
  ).done;

  assert.deepEqual(seen.credentialCalls, [ALL]);
  assert.deepEqual(
    seen.jobCalls.map((c) => [c.bankKey, c.credentials]),
    ALL.map((k) => [k, creds]),
  );
});

test('a broken Bitwarden item fails only its run, and its job is never called', async () => {
  const { service, seen, requests, store } = setup({
    credentials: (bankKeys) =>
      new Map(
        bankKeys.map((k) => [
          k,
          k === 'bacCr'
            ? { ok: false, scope: 'item', error: new Error('Bitwarden item "cr" has no password') }
            : { ok: true, credentials: creds },
        ]),
      ),
  });
  const { started, done } = await service.startBatch(requests(ALL), 'schedule');
  await done;

  const cr = store.rows.get(started.find((r) => r.bankKey === 'bacCr')!.runId)!;
  assert.equal(cr.status, 'failed');
  assert.deepEqual(cr.error, {
    message: 'Bitwarden item "cr" has no password',
    stage: 'credentials',
  });
  assert.deepEqual(
    seen.jobCalls.map((c) => c.bankKey),
    ['bancoIndustrialGt', 'bacGt'],
  );
  assert.deepEqual(
    seen.runAlerts.map((r) => r.bankKey),
    ['bacCr'],
  );
});

test('a Bitwarden session failure fails every run and sends ONE alert for the batch', async () => {
  const error = new Error('Bitwarden: `bw unlock` failed');
  const { service, seen, requests, store } = setup({
    credentials: (bankKeys) =>
      new Map(bankKeys.map((k) => [k, { ok: false, scope: 'session', error }])),
  });
  const { started, done } = await service.startBatch(requests(ALL), 'schedule');
  await done;

  assert.deepEqual(
    started.map((r) => store.rows.get(r.runId)!.status),
    ['failed', 'failed', 'failed'],
  );
  assert.equal(store.rows.get(started[0]!.runId)!.error!.stage, 'credentials');
  assert.deepEqual(seen.jobCalls, []);
  assert.deepEqual(seen.runAlerts, []);
  assert.equal(seen.batchAlerts.length, 1);
  assert.deepEqual(
    seen.batchAlerts[0]!.runs.map((r) => r.bankKey),
    ALL,
  );
  assert.equal(seen.batchAlerts[0]!.error, error);
});

test('a config row that cannot be read fails the whole batch before Bitwarden is touched', async () => {
  const { service, seen, requests, store } = setup({
    loadConfig: async () => {
      throw new Error("config row 'general' not found");
    },
  });
  const { started, done } = await service.startBatch(requests(ALL), 'schedule');
  await done;

  assert.deepEqual(
    started.map((r) => store.rows.get(r.runId)!.error!.stage),
    ['config', 'config', 'config'],
  );
  assert.deepEqual(seen.credentialCalls, []);
  assert.equal(seen.batchAlerts.length, 1);
});

test('a bank that is already running is not started again; the rest of the batch is', async () => {
  const gate = deferred<RunResult>();
  const { service, seen, requests } = setup({ job: { bacGt: () => gate.promise } });

  const first = await service.startBatch(requests(['bacGt']), 'manual');
  const second = await service.startBatch(requests(ALL), 'schedule');

  assert.deepEqual(
    second.alreadyRunning.map((r) => r.runId),
    [first.started[0]!.runId],
  );
  assert.deepEqual(
    second.started.map((r) => r.bankKey),
    ['bancoIndustrialGt', 'bacCr'],
  );

  gate.resolve(okResult);
  await Promise.all([first.done, second.done]);
  assert.deepEqual(seen.jobCalls.map((c) => c.bankKey).sort(), [
    'bacCr',
    'bacGt',
    'bancoIndustrialGt',
  ]);
});

test('the bank lock is released after a success and after a failure', async () => {
  let calls = 0;
  const { service, requests } = setup({
    job: {
      bacGt: async () => {
        if (++calls === 2) {
          throw new Error('second run fails');
        }
        return okResult;
      },
    },
  });
  for (let i = 0; i < 3; i++) {
    const { started, alreadyRunning, done } = await service.startBatch(
      requests(['bacGt']),
      'manual',
    );
    assert.equal(started.length, 1, `run ${i + 1} should start`);
    assert.deepEqual(alreadyRunning, []);
    await done;
  }
  assert.equal(calls, 3);
});

test('an alert that cannot be sent leaves the run failed and the batch settled', async () => {
  const { service, requests, store } = setup({
    alertThrows: true,
    job: {
      bacGt: async () => {
        throw new Error('boom');
      },
    },
  });
  const { started, done } = await service.startBatch(requests(['bacGt']), 'manual');
  await done;
  assert.equal(store.rows.get(started[0]!.runId)!.status, 'failed');
});

test('months default to the current month rule; given months are kept', async () => {
  const { service, seen } = setup();
  const now = new Date(2026, 9, 4, 7, 0);
  await (
    await service.startBatch(
      [
        { bankKey: 'bacGt', params: {} },
        { bankKey: 'bacCr', params: { months: ['2026-03'], dryRun: true } },
      ],
      'manual',
      now,
    )
  ).done;

  const params = Object.fromEntries(seen.jobCalls.map((c) => [c.bankKey, c.params]));
  assert.deepEqual(params.bacGt, { months: ['2026-09', '2026-10'], dryRun: false });
  assert.deepEqual(params.bacCr, { months: ['2026-03'], dryRun: true });
});

test("an account that is not one of the bank's fails the run without opening a browser", async () => {
  const { service, seen, store } = setup();
  const { started, done } = await service.startBatch(
    [{ bankKey: 'bacGt', params: { account: '999' } }],
    'manual',
  );
  await done;

  const run = store.rows.get(started[0]!.runId)!;
  assert.equal(run.status, 'failed');
  assert.equal(run.error!.stage, 'config');
  assert.match(run.error!.message, /999/);
  assert.deepEqual(seen.jobCalls, []);
});

test('the job gets only the requested account', async () => {
  const { service, seen } = setup();
  await (
    await service.startBatch([{ bankKey: 'bacGt', params: { account: '222' } }], 'manual')
  ).done;
  assert.equal(seen.jobCalls[0]!.params.account, '222');
});

test("with no months requested, a run reaches back to the bank's last full success", async () => {
  // bacGt was last fully scraped on Oct 28; this run is on Nov 11, past the 10-day rule.
  const { service, seen } = setup({
    seed: [
      pastRun({
        runId: 'old-gt',
        bankKey: 'bacGt',
        startedAt: new Date(2026, 9, 28, 7).toISOString(),
        params: { months: ['2026-10'], dryRun: false },
      }),
      // A newer dry run and a newer single-account run do not count as "the bank was scraped".
      pastRun({
        runId: 'dry-gt',
        bankKey: 'bacGt',
        startedAt: new Date(2026, 10, 5, 7).toISOString(),
        params: { months: ['2026-11'], dryRun: true },
      }),
      pastRun({
        runId: 'one-account-gt',
        bankKey: 'bacGt',
        startedAt: new Date(2026, 10, 6, 7).toISOString(),
        params: { months: ['2026-11'], account: '222', dryRun: false },
      }),
    ],
  });
  await (
    await service.startBatch(
      [
        { bankKey: 'bacGt', params: {} },
        { bankKey: 'bacCr', params: {} },
      ],
      'schedule',
      new Date(2026, 10, 11, 7),
    )
  ).done;

  const months = Object.fromEntries(seen.jobCalls.map((c) => [c.bankKey, c.params.months]));
  assert.deepEqual(months.bacGt, ['2026-10', '2026-11']);
  assert.deepEqual(months.bacCr, ['2026-11'], 'a bank with no history uses the default rule');
});

test('a gap longer than the automatic reach scrapes the recent months and alerts about the rest', async () => {
  const { service, seen } = setup({
    seed: [
      pastRun({
        runId: 'old-gt',
        bankKey: 'bacGt',
        startedAt: new Date(2026, 2, 20, 7).toISOString(),
        params: { months: ['2026-03'], dryRun: false },
      }),
    ],
  });
  await (
    await service.startBatch(
      [{ bankKey: 'bacGt', params: {} }],
      'schedule',
      new Date(2026, 9, 15, 7),
    )
  ).done;

  assert.deepEqual(seen.jobCalls[0]!.params.months, ['2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(seen.skippedAlerts, [
    { bankKey: 'bacGt', skipped: ['2026-03', '2026-04', '2026-05', '2026-06'] },
  ]);
});

test('a run that cannot be stored is not started, and does not hold the bank lock', async () => {
  const { service, seen, requests, store } = setup();
  store.failInsert = true;
  await assert.rejects(service.startBatch(requests(['bacGt']), 'manual'), /database is down/);
  assert.deepEqual(seen.jobCalls, []);

  store.failInsert = false;
  const { started, done } = await service.startBatch(requests(['bacGt']), 'manual');
  assert.equal(started.length, 1);
  await done;
});

test('on boot, runs a stopped process left running are failed', async () => {
  const { service, store } = setup({
    seed: [
      pastRun({
        runId: 'orphan',
        bankKey: 'bacGt',
        startedAt: new Date(2026, 9, 3, 7).toISOString(),
        status: 'running',
        finishedAt: null,
        result: null,
      }),
    ],
  });
  await service.onApplicationBootstrap();

  const orphan = store.rows.get('orphan')!;
  assert.equal(orphan.status, 'failed');
  assert.match(orphan.error!.message, /stopped before this run finished/);
});

test('get and list read the stored runs, newest first', async () => {
  const { service, requests } = setup();
  const first = await service.startBatch(
    requests(['bacGt']),
    'manual',
    new Date(2026, 9, 4, 7, 0, 1),
  );
  await first.done;
  const second = await service.startBatch(
    requests(['bacCr']),
    'manual',
    new Date(2026, 9, 4, 7, 0, 2),
  );
  await second.done;

  assert.deepEqual(
    (await service.list()).map((r) => r.runId),
    [second.started[0]!.runId, first.started[0]!.runId],
  );
  assert.equal((await service.get(first.started[0]!.runId))!.status, 'succeeded');
  assert.equal(await service.get('nope'), undefined);
});
