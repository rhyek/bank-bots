import { Injectable } from '@nestjs/common';
import { and, db, desc, eq, isNull, scrapeRun } from '@bank-bots/db';
import type { BankKey } from '~/bank-config/bank-keys';
import type { Run, RunError, RunResult } from './scrape.dto';

export type RunFinish = Pick<Run, 'status' | 'finishedAt' | 'result' | 'error'>;

/** The `scrape_run` table. The seam a spec replaces with an in-memory one. */
export abstract class ScrapeRunStore {
  abstract insert(run: Run): Promise<void>;
  abstract finish(runId: string, finish: RunFinish): Promise<void>;
  abstract get(runId: string): Promise<Run | undefined>;
  abstract list(limit: number): Promise<Run[]>;
  /** Succeeded, not dry, whole-bank runs of one bank, newest first. */
  abstract succeededFullRuns(bankKey: BankKey): Promise<Run[]>;
  /** Fails every run still marked running. Returns how many. */
  abstract failInterrupted(finishedAt: string, message: string): Promise<number>;
}

type Row = typeof scrapeRun.$inferSelect;

function toRun(row: Row): Run {
  return {
    runId: row.id,
    bankKey: row.bankKey as BankKey,
    trigger: row.trigger as Run['trigger'],
    status: row.status as Run['status'],
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    params: {
      months: row.months,
      ...(row.account ? { account: row.account } : {}),
      dryRun: row.dryRun,
    },
    result: (row.result as RunResult | null) ?? null,
    error: (row.error as RunError | null) ?? null,
  };
}

@Injectable()
export class DrizzleScrapeRunStore extends ScrapeRunStore {
  async insert(run: Run): Promise<void> {
    await db.insert(scrapeRun).values({
      id: run.runId,
      bankKey: run.bankKey,
      trigger: run.trigger,
      status: run.status,
      startedAt: new Date(run.startedAt),
      months: run.params.months,
      account: run.params.account ?? null,
      dryRun: run.params.dryRun,
    });
  }

  async finish(runId: string, finish: RunFinish): Promise<void> {
    await db
      .update(scrapeRun)
      .set({
        status: finish.status,
        finishedAt: finish.finishedAt ? new Date(finish.finishedAt) : null,
        result: finish.result,
        error: finish.error,
      })
      .where(eq(scrapeRun.id, runId));
  }

  async get(runId: string): Promise<Run | undefined> {
    const [row] = await db.select().from(scrapeRun).where(eq(scrapeRun.id, runId)).limit(1);
    return row ? toRun(row) : undefined;
  }

  async list(limit: number): Promise<Run[]> {
    const rows = await db.select().from(scrapeRun).orderBy(desc(scrapeRun.startedAt)).limit(limit);
    return rows.map(toRun);
  }

  async succeededFullRuns(bankKey: BankKey): Promise<Run[]> {
    const rows = await db
      .select()
      .from(scrapeRun)
      .where(
        and(
          eq(scrapeRun.bankKey, bankKey),
          eq(scrapeRun.status, 'succeeded'),
          eq(scrapeRun.dryRun, false),
          isNull(scrapeRun.account),
        ),
      )
      .orderBy(desc(scrapeRun.startedAt))
      // Far more than needed: the newest one almost always covers its own month.
      .limit(20);
    return rows.map(toRun);
  }

  async failInterrupted(finishedAt: string, message: string): Promise<number> {
    const error: RunError = { message, stage: 'scrape' };
    const rows = await db
      .update(scrapeRun)
      .set({ status: 'failed', finishedAt: new Date(finishedAt), error })
      .where(eq(scrapeRun.status, 'running'))
      .returning({ id: scrapeRun.id });
    return rows.length;
  }
}
