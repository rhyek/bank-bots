import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { BANK_KEYS } from '~/bank-config/bank-keys';
import { ScrapeAlertService } from './scrape-alert.service';
import { ScrapeRunsService } from './scrape-runs.service';

/** The service's one schedule: every bank, once a day. */
@Injectable()
export class ScrapeScheduleService {
  constructor(
    private readonly runs: ScrapeRunsService,
    private readonly alerts: ScrapeAlertService,
    private readonly logger: StructuredLoggerService,
  ) {}

  // 07:00 in Guatemala, the hour the retired Lambda schedule used. There is no catch-up for a tick
  // missed while the machine slept: the next run reaches back to the last successful one.
  @Cron('0 7 * * *', { name: 'daily-scrape', timeZone: 'America/Guatemala' })
  async tick(): Promise<void> {
    try {
      const { started, alreadyRunning, done } = await this.runs.startBatch(
        BANK_KEYS.map((bankKey) => ({ bankKey, params: {} })),
        'schedule',
      );
      for (const run of alreadyRunning) {
        this.logger.warn(
          { bankKey: run.bankKey, runId: run.runId },
          'scheduled scrape skipped: the bank already has a run in progress',
        );
      }
      this.logger.info({ runIds: started.map((r) => r.runId) }, 'scheduled scrape started');
      await done;
    } catch (error) {
      // Never rethrown: nothing above a cron tick can do anything with it.
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logger.error({ error: failure }, 'the scheduled scrape could not start');
      await this.alerts.tickFailed(failure).catch((alertError: unknown) => {
        this.logger.warn({ reason: String(alertError) }, 'could not send the failure alert');
      });
    }
  }
}
