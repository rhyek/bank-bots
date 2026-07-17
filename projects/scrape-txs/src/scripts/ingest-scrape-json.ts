// Ingest a `--json` dry-run file (produced by `console.ts --json`) into bank_tx as an INSERT-ONLY
// upsert: onConflictDoNothing on the natural key, so txs missing from the DB are added and existing
// rows are left untouched. Pairs with the scraper's --json dry-run + a diff against the DB.
//
// Run: pnpm -C projects/scrape-txs exec node --import @swc-node/register/esm-register \
//        src/scripts/ingest-scrape-json.ts <path-to-json>

import fs from 'node:fs/promises';
import { bankTx, db, pool } from '@bank-bots/db';

interface ScrapeTx {
  date: string;
  docNo: string;
  description: string;
  amountCents: number;
}
interface ScrapeAccount {
  account_id: string;
  months: Record<string, ScrapeTx[]>;
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: ingest-scrape-json.ts <path-to-json>');
  const data = JSON.parse(await fs.readFile(path, 'utf8')) as ScrapeAccount[];
  const rows = data.flatMap((a) =>
    Object.entries(a.months).flatMap(([month, txs]) =>
      txs.map((t) => ({
        bankAccountId: a.account_id,
        month,
        date: t.date,
        docNo: t.docNo,
        description: t.description,
        amountCents: t.amountCents,
      })),
    ),
  );
  console.log(`read ${rows.length} txs from ${path}`);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await db
      .insert(bankTx)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing({
        target: [
          bankTx.bankAccountId,
          bankTx.date,
          bankTx.docNo,
          bankTx.description,
          bankTx.amountCents,
        ],
      });
    inserted += res.rowCount ?? 0;
  }
  console.log(`inserted ${inserted} new rows (existing left untouched)`);
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
