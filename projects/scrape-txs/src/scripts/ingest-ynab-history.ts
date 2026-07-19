// One-shot ingestion: pull every YNAB transaction that is NOT already in bank_tx and insert it, so
// SUM(bank_tx.amount) per account reflects the real account balance (bank_tx previously only held
// history from each account's first scraped month, missing the earlier opening-balance history).
//
// We can't re-scrape the banks (no creds here), so YNAB is the source — it has the full history and
// its balance reconciles to the bank. Matching is by (docNo, amount) IGNORING date, because YNAB
// dates are shifted vs the bank; a YNAB tx that matches an existing bank_tx is skipped, unmatched
// ones are inserted. Inserts use onConflictDoNothing as a final dup guard. Every inserted row gets
// created_at = now(), so the whole batch is reversible: DELETE FROM bank_tx WHERE created_at >= <ts>.
//
// Run: pnpm -C projects/scrape-txs exec node --import @swc-node/register/esm-register \
//        src/scripts/ingest-ynab-history.ts

import { bankTx, db, pool } from '@bank-bots/db';
import { YnabClient } from '../lib/ynab/client';

interface AccountMapEntry {
  ynabAccountId: string;
  bankKey: string;
  bankAccountNumber: string;
}

function parseDocNo(memo: string | null): string | null {
  if (!memo) {
    return null;
  }
  const strip = (ref: string) => {
    const core = ref.replace(/\(\d+\)$/, '');
    const dated = core.match(/^\d{8}_(.+)$/);
    return dated ? dated[1] : core;
  };
  const m = memo.match(/ref: ([\d_()]+);/);
  if (m) {
    return strip(m[1]);
  }
  try {
    const j: unknown = JSON.parse(memo);
    if (j && typeof j === 'object' && typeof (j as Record<string, unknown>).ref === 'string') {
      return strip((j as Record<string, string>).ref);
    }
  } catch {
    /* not json */
  }
  const r = memo.match(/reference:(\w+)/i);
  return r ? r[1] : null;
}

function parseDesc(memo: string | null): string | null {
  if (!memo) {
    return null;
  }
  const m = memo.match(/desc: (.+?);/);
  return m ? m[1] : null;
}

function chunk<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) {
    o.push(a.slice(i, i + n));
  }
  return o;
}

async function main() {
  const accessToken = process.env.YNAB_ACCESS_TOKEN;
  const budgetId = process.env.YNAB_BUDGET_ID;
  if (!accessToken || !budgetId) {
    throw new Error('YNAB_ACCESS_TOKEN and YNAB_BUDGET_ID must be set');
  }

  const watermark = new Date().toISOString();
  console.log(`ingestion watermark (revert with created_at >= this): ${watermark}\n`);

  const configRow = await db.query.config.findFirst({
    where: (c, { eq }) => eq(c.id, 'general'),
    columns: { data: true },
  });
  const accountsMap = ((configRow!.data as { ynab?: { accountsMap?: AccountMapEntry[] } }).ynab
    ?.accountsMap ?? []) as AccountMapEntry[];

  const bankAccounts = await db.query.bankAccount.findMany({
    columns: { id: true, bankKey: true, accountNumber: true },
  });
  const baId = new Map(bankAccounts.map((a) => [`${a.bankKey}|${a.accountNumber}`, a.id]));

  const importedPayees = new Set(
    (await db.query.payee.findMany({ columns: { id: true } })).map((p) => p.id),
  );
  const importedCategories = new Set(
    (await db.query.category.findMany({ columns: { id: true } })).map((c) => c.id),
  );

  const client = new YnabClient(accessToken, budgetId);

  type InsertRow = typeof bankTx.$inferInsert;
  const allInserts: InsertRow[] = [];

  for (const entry of accountsMap) {
    const bankAccountId = baId.get(`${entry.bankKey}|${entry.bankAccountNumber}`);
    if (!bankAccountId) {
      console.warn(`no bank_account for ${entry.bankKey}/${entry.bankAccountNumber}; skipping`);
      continue;
    }
    const ynabTxs = (await client.getAccountTransactions(entry.ynabAccountId)).filter(
      (t) => !t.deleted,
    );

    // index existing bank_tx by (docNo|amountMilli) -> list of dates (ms). Match by docNo+amount but
    // only within a date window, so YNAB's manual date-shifts still match while the same reference
    // number reused years apart (common on 904201043) does NOT cross-match.
    const existing = await db.query.bankTx.findMany({
      where: (t, { eq }) => eq(t.bankAccountId, bankAccountId),
      columns: { docNo: true, amountCents: true, date: true },
    });
    const existingIdx = new Map<string, number[]>();
    for (const r of existing) {
      const k = `${r.docNo}|${r.amountCents * 10}`; // cents*10 == YNAB milliunits
      const arr = existingIdx.get(k) ?? [];
      arr.push(new Date(r.date).getTime());
      existingIdx.set(k, arr);
    }
    const WINDOW_MS = 90 * 24 * 3600 * 1000;

    // in-batch uniqueness for the (date,docNo,description,amount) unique index
    const batchKeys = new Set<string>();
    const rows: InsertRow[] = [];
    let matched = 0;
    for (const tx of ynabTxs) {
      const amountMilli = tx.amount;
      const docNo = parseDocNo(tx.memo);
      const txMs = new Date(tx.date).getTime();
      if (docNo != null) {
        const arr = existingIdx.get(`${docNo}|${amountMilli}`);
        const i = arr?.findIndex((d) => Math.abs(d - txMs) <= WINDOW_MS) ?? -1;
        if (arr && i >= 0) {
          arr.splice(i, 1); // consume one existing match
          matched++;
          continue;
        }
      }
      let doc = docNo ?? `ynab-${tx.id}`;
      const description =
        parseDesc(tx.memo) ?? tx.payee_name ?? tx.import_payee_name ?? '(no description)';
      const amountCents = Math.round(tx.amount / 10); // YNAB milliunits -> cents
      // guarantee uniqueness within the batch so nothing is dropped by the unique index
      let ukey = `${tx.date}|${doc}|${description}|${amountCents}`;
      let n = 1;
      while (batchKeys.has(ukey)) {
        n++;
        doc = `${docNo ?? `ynab-${tx.id}`}#${n}`;
        ukey = `${tx.date}|${doc}|${description}|${amountCents}`;
      }
      batchKeys.add(ukey);
      rows.push({
        bankAccountId,
        month: tx.date.slice(0, 7),
        date: tx.date,
        docNo: doc,
        description,
        amountCents,
        payeeId: tx.payee_id && importedPayees.has(tx.payee_id) ? tx.payee_id : undefined,
        categoryId:
          tx.category_id && importedCategories.has(tx.category_id) ? tx.category_id : undefined,
      });
    }
    console.log(
      `${entry.bankKey}/${entry.bankAccountNumber}: ynab=${ynabTxs.length} matched-existing=${matched} to-insert=${rows.length} (sum ${(rows.reduce((s, r) => s + r.amountCents, 0) / 100).toFixed(2)})`,
    );
    allInserts.push(...rows);
  }

  console.log(`\ninserting ${allInserts.length} rows...`);
  for (const c of chunk(allInserts, 500)) {
    await db
      .insert(bankTx)
      .values(c)
      .onConflictDoNothing({
        target: [
          bankTx.bankAccountId,
          bankTx.date,
          bankTx.docNo,
          bankTx.description,
          bankTx.amountCents,
        ],
      });
  }
  console.log('done inserting');
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
