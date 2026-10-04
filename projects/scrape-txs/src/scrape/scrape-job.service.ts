import fs from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import dayjs from 'dayjs';
import { type BrowserContext, chromium } from 'playwright';
import { z } from 'zod';
import { bankAccount, bankTx, db, eq, inArray, sql } from '@bank-bots/db';
import type { BankKey } from '~/bank-config/bank-keys';
import type { Config } from '~/bank-config/config-schema';
import type { BankCredentials } from '~/credentials/bitwarden';
import { bacScrape } from './banks/bac/scrape';
import { bancoIndustrialScrape } from './banks/banco-industrial/scrape';
import type { RunParams, RunResult, RunStage } from './scrape.dto';
import { chromeUserAgent } from './user-agent';

export type ScrapeJobInput = {
  runId: string;
  bankKey: BankKey;
  params: RunParams;
  /** Already fetched by the batch: the job never talks to Bitwarden. */
  credentials: BankCredentials;
  config: Config;
};

/** A run's failure, carrying where it stopped and, for a scrape, the trace that shows why. */
export class ScrapeFailure extends Error {
  readonly tracePath?: string;

  constructor(
    readonly stage: RunStage,
    message: string,
    opts: { tracePath?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ScrapeFailure';
    this.tracePath = opts.tracePath;
  }
}

type Scraped = {
  createTxs: (typeof bankTx.$inferInsert)[];
  deleteTxIds: string[];
  runningBalances: Record<string, number>;
};

const MAX_ATTEMPTS = 2;

// From the package directory, not the working directory: `storage/` is gitignored there.
const RUNS_DIR = path.resolve(import.meta.dirname, '../../storage/runs');

/** Where a run keeps its files: the trace of a failure, the output of a dry run. */
export function runDir(runId: string): string {
  return path.join(RUNS_DIR, runId);
}

/**
 * One bank's scrape, with credentials it was handed: its own Chromium, a fresh context per attempt,
 * then one transaction to store what it found. Everything it opens it closes, whatever happens, and
 * nothing it does is shared with another bank's job.
 */
@Injectable()
export class ScrapeJobService {
  constructor(private readonly logger: StructuredLoggerService) {}

  async run(input: ScrapeJobInput): Promise<RunResult> {
    const scraped = await this.scrape(input);
    try {
      return input.params.dryRun
        ? await this.writeDryRun(input, scraped)
        : await this.persist(input, scraped);
    } catch (error) {
      throw new ScrapeFailure('persist', (error as Error).message, { cause: error });
    }
  }

  private async scrape(input: ScrapeJobInput): Promise<Scraped> {
    // `channel: 'chromium'` is Chromium's new headless mode — the full browser without a window —
    // rather than Playwright's default cut-down headless shell.
    const browser = await chromium.launch({
      args: ['--deny-permission-prompts'],
      headless: true,
      channel: 'chromium',
    });
    try {
      for (let attempt = 1; ; attempt++) {
        this.logger.info({ attempt }, 'scrape attempt started');
        // A fresh context per attempt so a retry doesn't inherit cookies/storage from the failed
        // one. BAC, for example, sets a country-preference cookie on the first attempt that would
        // otherwise redirect the retry's `goto` away from the home page its country-selector step
        // expects, making the retry fail at a misleading step.
        const context = await browser.newContext({
          userAgent: chromeUserAgent(browser.version()),
        });
        try {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
          return await this.scrapeBank(input, context);
        } catch (error) {
          // Only the last attempt's trace is kept. Earlier ones are discarded when their context
          // closes below.
          if (attempt >= MAX_ATTEMPTS) {
            const tracePath = await this.saveTrace(context, input.runId);
            throw new ScrapeFailure('scrape', (error as Error).message, {
              tracePath,
              cause: error,
            });
          }
          this.logger.warn(
            { attempt, reason: (error as Error).message },
            'scrape attempt failed; retrying',
          );
        } finally {
          await context.close().catch((error: unknown) => {
            this.logger.warn({ reason: String(error) }, 'could not close the browser context');
          });
        }
      }
    } finally {
      await browser.close().catch((error: unknown) => {
        this.logger.warn({ reason: String(error) }, 'could not close the browser');
      });
    }
  }

  private async scrapeBank(
    { bankKey, params, credentials, config }: ScrapeJobInput,
    context: BrowserContext,
  ): Promise<Scraped> {
    const page = await context.newPage();
    const months = params.months.map((month) => dayjs(month));
    const only = <A extends { number: string }>(accounts: A[]) =>
      params.account ? accounts.filter((a) => a.number === params.account) : accounts;

    if (bankKey === 'bancoIndustrialGt') {
      return await bancoIndustrialScrape({
        bankKey,
        biConfig: {
          auth: { ...credentials, code: z.string().parse(credentials.code) },
          accounts: only(config.banks.bancoIndustrialGt.accounts),
        },
        months,
        page,
        log: this.logger,
      });
    }
    const bank = config.banks[bankKey];
    return await bacScrape({
      bankKey,
      config: { ...bank, accounts: only(bank.accounts), auth: credentials },
      months,
      page,
      log: this.logger,
    });
  }

  private async saveTrace(context: BrowserContext, runId: string): Promise<string | undefined> {
    try {
      const tracePath = path.join(runDir(runId), 'trace.zip');
      await fs.mkdir(path.dirname(tracePath), { recursive: true });
      await context.tracing.stop({ path: tracePath });
      this.logger.info({ tracePath }, 'saved the Playwright trace');
      return tracePath;
    } catch (error) {
      this.logger.warn({ reason: String(error) }, 'could not save the Playwright trace');
      return undefined;
    }
  }

  /** A dry run: the scraped rows go to a file, grouped by account and month. No database write. */
  private async writeDryRun({ runId }: ScrapeJobInput, scraped: Scraped): Promise<RunResult> {
    const byAccount = new Map<string, Record<string, unknown[]>>();
    for (const tx of scraped.createTxs) {
      const months = byAccount.get(tx.bankAccountId) ?? {};
      (months[tx.month] ??= []).push({
        date: tx.date,
        docNo: tx.docNo,
        description: tx.description,
        amountCents: tx.amountCents,
      });
      byAccount.set(tx.bankAccountId, months);
    }
    const out = [...byAccount.entries()].map(([account_id, months]) => ({ account_id, months }));
    const dryRunPath = path.join(runDir(runId), 'scraped.json');
    await fs.mkdir(path.dirname(dryRunPath), { recursive: true });
    await fs.writeFile(dryRunPath, JSON.stringify(out, null, 2));
    return {
      upserted: scraped.createTxs.length,
      deleted: scraped.deleteTxIds.length,
      balancesUpdated: 0,
      dryRunPath,
    };
  }

  private async persist(_input: ScrapeJobInput, scraped: Scraped): Promise<RunResult> {
    const { createTxs, deleteTxIds, runningBalances } = scraped;
    if (createTxs.length > 0 || deleteTxIds.length > 0) {
      await db.transaction(async (tx) => {
        if (createTxs.length > 0) {
          // One batched multi-row upsert. (Not `Promise.all` of per-row inserts: that fires
          // concurrent queries on the transaction's single client, which pg deprecates and removes
          // in pg@9.) `excluded.amount` is the incoming value — a no-op today since amount is part
          // of the conflict key, but it keeps the "update amount on conflict" intent if the key
          // changes.
          await tx
            .insert(bankTx)
            .values(createTxs)
            .onConflictDoUpdate({
              target: [
                bankTx.bankAccountId,
                bankTx.date,
                bankTx.docNo,
                bankTx.description,
                bankTx.amountCents,
                bankTx.occurrence,
              ],
              set: { amountCents: sql`excluded.amount_cents` },
            });
        }
        if (deleteTxIds.length > 0) {
          this.logger.info({ deleteTxIds }, 'deleting stored rows the bank no longer lists');
          await tx.delete(bankTx).where(inArray(bankTx.id, deleteTxIds));
        }
      });
    }
    const balances = Object.entries(runningBalances);
    for (const [accountId, balance] of balances) {
      await db
        .update(bankAccount)
        .set({ runningBalanceCents: balance })
        .where(eq(bankAccount.id, accountId));
    }
    return {
      upserted: createTxs.length,
      deleted: deleteTxIds.length,
      balancesUpdated: balances.length,
    };
  }
}
