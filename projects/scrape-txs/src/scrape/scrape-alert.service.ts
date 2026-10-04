import { Injectable } from '@nestjs/common';
import { mailer } from './mail';
import type { Run } from './scrape.dto';

/** Failure emails to the owner. The subject is what the `fix-scrape-bugs` skill keys on. */
@Injectable()
export class ScrapeAlertService {
  async runFailed(run: Run): Promise<void> {
    await mailer.sendMail({
      to: process.env.MAILER_ME,
      subject: `Scrape bank txs failed for ${run.bankKey}`,
      text: [
        `Error:\n${run.error?.message}`,
        `Stage: ${run.error?.stage}`,
        `Run: ${run.runId} (${run.trigger}), months ${run.params.months.join(', ')}`,
        ...(run.error?.tracePath ? [`Trace: ${run.error.tracePath}`] : []),
      ].join('\n\n'),
    });
  }

  /** One email for a batch that failed as a whole, instead of the same email once per bank. */
  async batchFailed(runs: Run[], error: Error): Promise<void> {
    await mailer.sendMail({
      to: process.env.MAILER_ME,
      subject: `Scrape bank txs failed for ${runs.map((r) => r.bankKey).join(', ')}`,
      text: [
        `Error:\n${error.message}`,
        `Stage: ${runs[0]?.error?.stage}`,
        `No bank was scraped. Runs: ${runs.map((r) => r.runId).join(', ')}`,
      ].join('\n\n'),
    });
  }

  /** The scheduled scrape could not even be started (the database was unreachable, say). */
  async tickFailed(error: Error): Promise<void> {
    await mailer.sendMail({
      to: process.env.MAILER_ME,
      subject: 'Scrape bank txs failed: the scheduled run could not start',
      text: `Error:\n${error.message}\n\nNo bank was scraped.`,
    });
  }

  /** The gap since the bank's last successful scrape is longer than a run reaches on its own. */
  async monthsSkipped(run: Run, skipped: string[]): Promise<void> {
    await mailer.sendMail({
      to: process.env.MAILER_ME,
      subject: `Scrape bank txs: ${run.bankKey} has months that were not scraped`,
      text: [
        `${run.bankKey} was last fully scraped long enough ago that this run does not reach back to it.`,
        `Scraped now: ${run.params.months.join(', ')}`,
        `NOT scraped: ${skipped.join(', ')}`,
        `To backfill them: POST /scrape/${run.bankKey} with {"months": ${JSON.stringify(skipped)}}`,
      ].join('\n\n'),
    });
  }
}
