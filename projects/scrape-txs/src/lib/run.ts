import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type dayjs from 'dayjs';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import lambdaChromium from '@sparticuz/chromium';
import { z } from 'zod';
import { bacScrape } from './bac/scrape';
import { bancoIndustrialScrape } from './banco-industrial/scrape';
import { bacSchema, configSchema } from './config-schema';
import { db, type DB, type InsertObject } from './db';
import { isLambda } from './utils';

export async function run(months: dayjs.Dayjs[]) {
  const bankKey = z.string().parse(process.env.BANK_KEY);
  const { data: configJson } = await db
    .selectFrom('config')
    .select('data')
    .where('id', '=', 'general')
    .executeTakeFirstOrThrow();
  const config = configSchema.parse(configJson);
  console.log('chromium args', lambdaChromium.args);
  const browser = isLambda()
    ? await chromium.launch({
        args: lambdaChromium.args,
        executablePath: await lambdaChromium.executablePath(),
        headless: true,
      })
    : await chromium.launch({
        headless: false,
      });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  if (isLambda()) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
  }
  const page = await context.newPage();

  let createTxs: InsertObject<DB, 'bank_txs'>[];
  let deleteTxIds: string[];
  try {
    const result = await (async () => {
      if (bankKey === 'bancoIndustrialGt') {
        return await bancoIndustrialScrape({
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
  } catch (error: any) {
    if (error.constructor?.name === 'TimeoutError' && isLambda()) {
      const zipExtension = '.zip';
      const traceAbsolutePath = `/tmp/trace${zipExtension}`;
      await context.tracing.stop({ path: traceAbsolutePath });
      const buffer = await fs.readFile(traceAbsolutePath);
      const s3Client = new S3Client({});
      const objectKey = `${new Date().getTime()}_${bankKey}${zipExtension}`;
      // AWS_REGION is provided by lambda: https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html#configuration-envvars-runtime
      const region = process.env.AWS_REGION!;
      const bucket = process.env.PLAYWRIGHT_TRACES_S3_BUCKET_ID;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: buffer,
      });
      await s3Client.send(command);
      const objectUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(
        objectKey
      )}`;
      const viewTraceUrl = `https://trace.playwright.dev/?trace=${objectUrl}`;
      throw new Error(
        `
Trace file: ${objectUrl}

View trace: ${viewTraceUrl}\
`,
        {
          cause: error,
        }
      );
    }
    throw error;
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  if (createTxs.length > 0 || deleteTxIds.length > 0) {
    await db.transaction().execute(async (sqlTx) => {
      if (createTxs.length > 0) {
        console.log(
          `Inserting/updating ${createTxs.length} ${bankKey} transactions...`
        );
        await Promise.all(
          createTxs.map(async (bankTx) => {
            try {
              await sqlTx
                .insertInto('bank_txs')
                .values(bankTx)
                .onConflict((oc) =>
                  oc
                    .columns([
                      'bank_key',
                      'account_number',
                      'date',
                      'doc_no',
                      'description',
                      'amount',
                    ])
                    .doUpdateSet({ amount: bankTx.amount })
                )
                .execute();
            } catch (error) {
              console.error('Failed to insert/update tx', bankTx);
              throw error;
            }
          })
        );
      }
      if (deleteTxIds.length > 0) {
        console.log(
          `Deleting ${deleteTxIds.join(', ')} ${bankKey} transactions...`
        );
        await sqlTx
          .deleteFrom('bank_txs')
          .where('id', 'in', deleteTxIds)
          .execute();
      }
    });
    console.log('Done.');
  }

  await db.destroy();
}
