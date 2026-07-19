import fs from 'node:fs/promises';
import path from 'node:path';
import type dayjs from 'dayjs';
import { chromium } from 'playwright';
import { z } from 'zod';
import { bacScrape } from './bac/scrape';
import { bancoIndustrialScrape } from './banco-industrial/scrape';
import { configSchema } from './config-schema';
import { bankAccount, bankTx, db, eq, inArray, pool, sql } from '@bank-bots/db';

export async function run(
  months: dayjs.Dayjs[],
  bankKeyInput: string | undefined,
  opts: { traceDir?: string; jsonPath?: string; accountNumber?: string } = {},
) {
  const { traceDir = path.join('storage', 'playwright-traces'), jsonPath, accountNumber } = opts;
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
  let createTxs: (typeof bankTx.$inferInsert)[];
  let deleteTxIds: string[];
  let runningBalances: Record<string, number>;
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
            const biConfig = config.banks.bancoIndustrialGt;
            return await bancoIndustrialScrape({
              bankKey,
              biConfig: accountNumber
                ? {
                    ...biConfig,
                    accounts: biConfig.accounts.filter((a) => a.number === accountNumber),
                  }
                : biConfig,
              months,
              page,
            });
          } else if (['bacGt', 'bacCr'].includes(bankKey)) {
            const bankConfig = config.banks[bankKey as 'bacGt' | 'bacCr'];
            return await bacScrape({
              bankKey,
              config: accountNumber
                ? {
                    ...bankConfig,
                    accounts: bankConfig.accounts.filter((a) => a.number === accountNumber),
                  }
                : bankConfig,
              months,
              page,
            });
          } else {
            throw new Error(`Unknown bank key: ${bankKey}`);
          }
        })();
        createTxs = result.createTxs;
        deleteTxIds = result.deleteTxIds;
        runningBalances =
          'runningBalances' in result ? (result.runningBalances as Record<string, number>) : {};
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

  // Dry run: dump scraped txs to JSON grouped by account + month, and do NOT touch the DB.
  if (jsonPath) {
    const byAccount = new Map<string, Record<string, unknown[]>>();
    for (const tx of createTxs) {
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
    await fs.writeFile(jsonPath, JSON.stringify(out, null, 2));
    console.log(
      `--json: wrote ${createTxs.length} scraped txs for ${out.length} account(s) to ${jsonPath} (no DB write; ${deleteTxIds.length} deletes skipped).`,
    );
    await pool.end();
    return;
  }

  if (createTxs.length > 0 || deleteTxIds.length > 0) {
    await db.transaction(async (tx) => {
      if (createTxs.length > 0) {
        console.log(`Inserting/updating ${createTxs.length} ${bankKey} transactions...`);
        // One batched multi-row upsert. (Not `Promise.all` of per-row inserts: that fires
        // concurrent queries on the transaction's single client, which pg deprecates and removes
        // in pg@9.) `excluded.amount` is the incoming value — a no-op today since amount is part of
        // the conflict key, but it keeps the "update amount on conflict" intent if the key changes.
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
            ],
            set: { amountCents: sql`excluded.amount_cents` },
          });
      }
      if (deleteTxIds.length > 0) {
        console.log(`Deleting ${deleteTxIds.join(', ')} ${bankKey} transactions...`);
        await tx.delete(bankTx).where(inArray(bankTx.id, deleteTxIds));
      }
    });
    console.log('Done.');
  }

  if (Object.keys(runningBalances).length > 0) {
    for (const [accountId, balance] of Object.entries(runningBalances)) {
      await db
        .update(bankAccount)
        .set({ runningBalanceCents: balance })
        .where(eq(bankAccount.id, accountId));
    }
    console.log(`Updated running_balance for ${Object.keys(runningBalances).length} account(s).`);
  }

  await pool.end();
}
