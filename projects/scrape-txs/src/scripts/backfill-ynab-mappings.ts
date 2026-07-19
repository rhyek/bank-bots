// One-shot backfill: import every YNAB payee + category (group) into Postgres, and replicate each
// categorized YNAB transaction's mapping onto the matching bank_tx (payee_id + category_id), plus
// transfers between the owner's own accounts (transfer_bank_account_id). Idempotent / re-runnable.
//
// Run (from repo root, with .env.local sourced for DATABASE_URL + YNAB_ACCESS_TOKEN + YNAB_BUDGET_ID):
//   pnpm -C projects/scrape-txs exec node --import @swc-node/register/esm-register \
//     src/scripts/backfill-ynab-mappings.ts
//
// Matching: a YNAB tx carries `ref: <YYYYMMDD_docNo>` in its memo (written by the retired update-ynab
// sync). We match back to a bank_tx by (bank_account, date, docNo, amount) — using the YNAB tx's own
// date/amount and the docNo parsed from the memo — falling back to (bank_account, date, amount) when
// the memo has no usable ref. Greedy first-unassigned wins for true same-key duplicates.

import { category, categoryGroup, db, payee, pool, sql } from '@bank-bots/db';
import { YnabClient } from '../lib/ynab/client';
import { docNoFromRef, parseYnabMemo } from '../lib/ynab/memo';

interface AccountMapEntry {
  ynabAccountId: string;
  bankKey: string;
  bankAccountNumber: string;
}

interface MatchRow {
  id: string;
  amountMilli: number;
  assigned: boolean;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function main() {
  const accessToken = process.env.YNAB_ACCESS_TOKEN;
  const budgetId = process.env.YNAB_BUDGET_ID;
  if (!accessToken || !budgetId) {
    throw new Error('YNAB_ACCESS_TOKEN and YNAB_BUDGET_ID must be set');
  }

  // --- config.ynab.accountsMap: ynabAccountId <-> (bankKey, accountNumber) ---
  const configRow = await db.query.config.findFirst({
    where: (c, { eq }) => eq(c.id, 'general'),
    columns: { data: true },
  });
  if (!configRow) {
    throw new Error("config row 'general' not found");
  }
  const accountsMap = ((configRow.data as { ynab?: { accountsMap?: AccountMapEntry[] } }).ynab
    ?.accountsMap ?? []) as AccountMapEntry[];
  if (accountsMap.length === 0) {
    throw new Error('config.ynab.accountsMap is empty');
  }

  // --- ynabAccountId -> bank_account.id ---
  const bankAccounts = await db.query.bankAccount.findMany({
    columns: { id: true, bankKey: true, accountNumber: true },
  });
  const bankAccountByKey = new Map(
    bankAccounts.map((a) => [`${a.bankKey}|${a.accountNumber}`, a.id]),
  );
  const ynabAcctToBankAcct = new Map<string, string>();
  for (const e of accountsMap) {
    const id = bankAccountByKey.get(`${e.bankKey}|${e.bankAccountNumber}`);
    if (!id) {
      console.warn(
        `no bank_account for ${e.bankKey}/${e.bankAccountNumber}; skipping accountsMap entry`,
      );
      continue;
    }
    ynabAcctToBankAcct.set(e.ynabAccountId, id);
  }
  console.log(`mapped ${ynabAcctToBankAcct.size} YNAB accounts to bank accounts`);

  // --- fetch YNAB data ---
  const client = new YnabClient(accessToken, budgetId);
  const [payees, categoryGroups, transactions] = await Promise.all([
    client.getPayees(),
    client.getCategoryGroups(),
    client.getTransactions(),
  ]);
  console.log(
    `fetched ${payees.length} payees, ${categoryGroups.length} category groups, ${transactions.length} transactions`,
  );

  // --- import payees ---
  const payeeRows = payees.filter((p) => !p.deleted).map((p) => ({ id: p.id, name: p.name }));
  for (const c of chunk(payeeRows, 500)) {
    await db
      .insert(payee)
      .values(c)
      .onConflictDoUpdate({ target: payee.id, set: { name: sql`excluded.name` } });
  }
  const importedPayees = new Set(payeeRows.map((p) => p.id));

  // --- import category groups, then categories (FK) ---
  const groupRows = categoryGroups
    .filter((g) => !g.deleted)
    .map((g) => ({ id: g.id, name: g.name, hidden: g.hidden }));
  for (const c of chunk(groupRows, 500)) {
    await db
      .insert(categoryGroup)
      .values(c)
      .onConflictDoUpdate({
        target: categoryGroup.id,
        set: { name: sql`excluded.name`, hidden: sql`excluded.hidden` },
      });
  }
  const importedGroups = new Set(groupRows.map((g) => g.id));
  const catRows = categoryGroups
    .flatMap((g) => g.categories)
    .filter((c) => !c.deleted && importedGroups.has(c.category_group_id))
    .map((c) => ({ id: c.id, name: c.name, groupId: c.category_group_id, hidden: c.hidden }));
  for (const c of chunk(catRows, 500)) {
    await db
      .insert(category)
      .values(c)
      .onConflictDoUpdate({
        target: category.id,
        set: {
          name: sql`excluded.name`,
          groupId: sql`excluded.group_id`,
          hidden: sql`excluded.hidden`,
        },
      });
  }
  const importedCategories = new Set(catRows.map((c) => c.id));
  console.log(
    `imported ${payeeRows.length} payees, ${groupRows.length} category groups, ${catRows.length} categories`,
  );

  // --- build match index over bank_tx keyed by (bank_account, date, docNo, amountMilli) ---
  const allBankTx = await db.query.bankTx.findMany({
    columns: { id: true, bankAccountId: true, date: true, docNo: true, amountCents: true },
  });
  const byFull = new Map<string, MatchRow[]>();
  const byNoDoc = new Map<string, MatchRow[]>();
  const push = (m: Map<string, MatchRow[]>, k: string, r: MatchRow) => {
    const l = m.get(k);
    if (l) {
      l.push(r);
    } else {
      m.set(k, [r]);
    }
  };
  for (const r of allBankTx) {
    const amountMilli = r.amountCents * 10; // cents*10 == YNAB milliunits
    const row: MatchRow = { id: r.id, amountMilli, assigned: false };
    push(byFull, `${r.bankAccountId}|${r.date}|${r.docNo}|${amountMilli}`, row);
    push(byNoDoc, `${r.bankAccountId}|${r.date}|${amountMilli}`, row);
  }
  const take = (m: Map<string, MatchRow[]>, k: string): MatchRow | undefined =>
    m.get(k)?.find((r) => !r.assigned);

  // --- compute updates from YNAB transactions ---
  const mappingUpdates: { id: string; payeeId: string; categoryId: string }[] = [];
  const transferUpdates: { id: string; transferBankAccountId: string }[] = [];
  const skip = { noAccount: 0, transferUnresolved: 0, noMappingData: 0, unmatched: 0 };

  const candidates = transactions
    .filter((t) => !t.deleted)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const tx of candidates) {
    const bankAccountId = ynabAcctToBankAcct.get(tx.account_id);
    if (!bankAccountId) {
      skip.noAccount++;
      continue;
    }

    let update: { payeeId: string; categoryId: string } | { transferBankAccountId: string };
    if (tx.transfer_account_id) {
      const other = ynabAcctToBankAcct.get(tx.transfer_account_id);
      if (!other) {
        skip.transferUnresolved++; // transfer to a non-scraped account (credit card, cash, ...)
        continue;
      }
      update = { transferBankAccountId: other };
    } else if (
      tx.payee_id &&
      tx.category_id &&
      importedPayees.has(tx.payee_id) &&
      importedCategories.has(tx.category_id)
    ) {
      update = { payeeId: tx.payee_id, categoryId: tx.category_id };
    } else {
      skip.noMappingData++;
      continue;
    }

    const docNo = docNoFromRef(parseYnabMemo(tx.memo).ref);
    let row: MatchRow | undefined;
    if (docNo != null) {
      row = take(byFull, `${bankAccountId}|${tx.date}|${docNo}|${tx.amount}`);
    }
    if (!row) {
      row = take(byNoDoc, `${bankAccountId}|${tx.date}|${tx.amount}`);
    }
    if (!row) {
      skip.unmatched++;
      continue;
    }
    row.assigned = true;

    if ('transferBankAccountId' in update) {
      transferUpdates.push({ id: row.id, transferBankAccountId: update.transferBankAccountId });
    } else {
      mappingUpdates.push({ id: row.id, payeeId: update.payeeId, categoryId: update.categoryId });
    }
  }

  console.log(
    `matched ${mappingUpdates.length} payee/category, ${transferUpdates.length} transfers`,
  );
  console.log(
    `skipped: noAccount=${skip.noAccount}, transferUnresolved=${skip.transferUnresolved}, noMappingData=${skip.noMappingData}, unmatched=${skip.unmatched}`,
  );

  // --- apply updates (batched VALUES upserts) ---
  for (const c of chunk(mappingUpdates, 500)) {
    const values = sql.join(
      c.map((u) => sql`(${u.id}::uuid, ${u.payeeId}::text, ${u.categoryId}::text)`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE bank_tx AS t SET payee_id = v.payee_id, category_id = v.category_id
      FROM (VALUES ${values}) AS v(id, payee_id, category_id)
      WHERE t.id = v.id`);
  }
  for (const c of chunk(transferUpdates, 500)) {
    const values = sql.join(
      c.map((u) => sql`(${u.id}::uuid, ${u.transferBankAccountId}::uuid)`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE bank_tx AS t SET transfer_bank_account_id = v.tbaid
      FROM (VALUES ${values}) AS v(id, tbaid)
      WHERE t.id = v.id`);
  }
  console.log('done');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
