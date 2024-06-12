import type dayjs from 'dayjs';
import { z } from 'zod';
import { bacGtScrape } from './bac-gt/scrape';
import { bancoIndustrialScrape } from './banco-industrial/scrape';
import { configSchema } from './config-schema';
import { db } from './db';

export async function run(months: dayjs.Dayjs[]) {
  const { data: configJson } = await db
    .selectFrom('config')
    .select('data')
    .where('id', '=', 'general')
    .executeTakeFirstOrThrow();
  const config = configSchema.parse(configJson);
  z.enum(['bancoIndustrialGt', 'bacGt'] as const).parse(process.env.BANK_KEY);

  const { createTxs, deleteTxIds } = await (async () => {
    if (process.env.BANK_KEY === 'bancoIndustrialGt') {
      return await bancoIndustrialScrape({
        biConfig: config.banks.bancoIndustrialGt,
        months,
      });
    } else if (process.env.BANK_KEY === 'bacGt') {
      return await bacGtScrape({
        config: config.banks.bacGt,
        months,
      });
    } else {
      throw new Error(`Unknown bank key: ${process.env.BANK_KEY}`);
    }
  })();

  if (createTxs.length > 0 || deleteTxIds.length > 0) {
    await db.transaction().execute(async (sqlTx) => {
      if (createTxs.length > 0) {
        console.log(
          `Inserting/updating ${createTxs.length} ${process.env.BANK_KEY} transactions...`
        );
        await Promise.all(
          createTxs.map(async (bankTx) => {
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
          })
        );
      }
      if (deleteTxIds.length > 0) {
        console.log(
          `Deleting ${deleteTxIds.join(', ')} ${
            process.env.BANK_KEY
          } transactions...`
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
