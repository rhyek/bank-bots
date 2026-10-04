import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import type { ScrapeAlertService } from './scrape-alert.service';
import type { Batch, BatchRequest, ScrapeRunsService } from './scrape-runs.service';
import { ScrapeScheduleService } from './scrape-schedule.service';

function setup(startBatch: (requests: BatchRequest[], trigger: string) => Promise<Batch>) {
  const alerts: Error[] = [];
  const service = new ScrapeScheduleService(
    { startBatch } as unknown as ScrapeRunsService,
    {
      tickFailed: async (error: Error) => void alerts.push(error),
    } as unknown as ScrapeAlertService,
    new StructuredLoggerService(),
  );
  return { service, alerts };
}

test('a tick starts one batch: the three banks, default parameters, trigger "schedule"', async () => {
  const calls: { requests: BatchRequest[]; trigger: string }[] = [];
  const { service } = setup(async (requests, trigger) => {
    calls.push({ requests, trigger });
    return { started: [], alreadyRunning: [], done: Promise.resolve() };
  });
  await service.tick();

  assert.deepEqual(calls, [
    {
      requests: [
        { bankKey: 'bancoIndustrialGt', params: {} },
        { bankKey: 'bacGt', params: {} },
        { bankKey: 'bacCr', params: {} },
      ],
      trigger: 'schedule',
    },
  ]);
});

test('a tick waits for its batch to end', async () => {
  let ended = false;
  const { service } = setup(async () => ({
    started: [],
    alreadyRunning: [],
    done: new Promise<void>((resolve) =>
      setTimeout(() => {
        ended = true;
        resolve();
      }, 5),
    ),
  }));
  await service.tick();
  assert.equal(ended, true);
});

test('a tick that cannot start its batch does not throw, and alerts the owner', async () => {
  const { service, alerts } = setup(async () => {
    throw new Error('database is down');
  });
  await service.tick();
  assert.deepEqual(
    alerts.map((e) => e.message),
    ['database is down'],
  );
});
