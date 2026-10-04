import type { StructuredLoggerService } from '@rhyek/nestjs-utils';

/** What a bank flow logs through: the job's logger, so its lines carry the run. */
export type ScrapeLog = Pick<StructuredLoggerService, 'info' | 'warn'>;

/** A human-looking pause of 1-3 seconds between steps on a bank's site. */
export function waitRandomMs() {
  const randomMilliSeconds = Math.floor(Math.random() * (3000 - 1000 + 1)) + 1000;
  return new Promise<void>((resolve) => {
    setTimeout(resolve, randomMilliSeconds);
  });
}
