import fs from 'node:fs/promises';
import path from 'node:path';
import type dayjs from 'dayjs';
import { inArray } from 'drizzle-orm';
import { chromium } from 'playwright';
import { z } from 'zod';
import { bacScrape } from './bac/scrape';
import { bancoIndustrialScrape } from './banco-industrial/scrape';
import { configSchema } from './config-schema';
import { bankTxs, db, pool } from './db';

export async function run(
  months: dayjs.Dayjs[],
  bankKeyInput: string | undefined,
  traceDir = path.join('storage', 'playwright-traces'),
) {
  const bankKey = z.string().parse(bankKeyInput);
  const configRow = await db.query.config.findFirst({
    where: (c, { eq }) => eq(c.id, 'general'),
    columns: { data: true },
  });
  if (!configRow) {
    throw new Error("config row 'general' not found");
  }
  const config = configSchema.parse(configRow.data);
  const browserArgs = ['--deny-permission-prompts'];
  const browser = await chromium.launch({
    args: browserArgs,
    headless: false,
  });
  let createTxs: (typeof bankTxs.$inferInsert)[];
  let deleteTxIds: number[];
  const maxAttempts = 2;
  let attempt = 0;

  try {
    while (true) {
      attempt++;
      console.log(`Attempt ${attempt} to scrape ${bankKey} transactions...`);
      // A fresh context per attempt so a retry doesn't inherit cookies/storage from the
      // failed one. BAC, for example, sets a country-preference cookie on the first attempt
      // that would otherwise redirect the retry's `goto` away from the home page its
      // country-selector step expects, making the retry fail at a misleading step.
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      });
      try {
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
        const page = await context.newPage();
        const result = await (async () => {
          if (bankKey === 'bancoIndustrialGt') {
            return await bancoIndustrialScrape({
              bankKey,
              biConfig: config.banks.bancoIndustrialGt,
              months,
              page,
            });
          } else if (['bacGt', 'bacCr'].includes(bankKey)) {
            return await bacScrape({
              bankKey,
              config: config.banks[bankKey as 'bacGt' | 'bacCr'],
              months,
              page,
            });
          } else {
            throw new Error(`Unknown bank key: ${bankKey}`);
          }
        })();
        createTxs = result.createTxs;
        deleteTxIds = result.deleteTxIds;
        break;
      } catch (error) {
        // Only persist a trace once we're giving up. Earlier attempts' traces are discarded
        // when their context closes in the `finally` below.
        if (attempt >= maxAttempts) {
          try {
            await fs.mkdir(traceDir, { recursive: true });
            const tracePath = path.join(traceDir, `${Date.now()}_${bankKey}.zip`);
            await context.tracing.stop({ path: tracePath });
            console.error(`Saved Playwright trace to ${tracePath}`);
          } catch (traceError) {
            console.error('Failed to save Playwright trace', traceError);
          }
          throw error;
        }
        console.warn(
          `Attempt ${attempt} failed with error: ${(error as Error).message}. Retrying...`,
        );
        continue;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (createTxs.length > 0 || deleteTxIds.length > 0) {
    await db.transaction(async (tx) => {
      if (createTxs.length > 0) {
        console.log(`Inserting/updating ${createTxs.length} ${bankKey} transactions...`);
        await Promise.all(
          createTxs.map(async (bankTx) => {
            try {
              await tx
                .insert(bankTxs)
                .values(bankTx)
                .onConflictDoUpdate({
                  target: [
                    bankTxs.bankKey,
                    bankTxs.accountNumber,
                    bankTxs.date,
                    bankTxs.docNo,
                    bankTxs.description,
                    bankTxs.amount,
                  ],
                  set: { amount: bankTx.amount },
                });
            } catch (error) {
              console.error('Failed to insert/update tx', bankTx);
              throw error;
            }
          }),
        );
      }
      if (deleteTxIds.length > 0) {
        console.log(`Deleting ${deleteTxIds.join(', ')} ${bankKey} transactions...`);
        await tx.delete(bankTxs).where(inArray(bankTxs.id, deleteTxIds));
      }
    });
    console.log('Done.');
  }

  await pool.end();
}
