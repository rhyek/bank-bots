import { bankAccount, db } from '@bank-bots/db';

// Resolve a `(bank_key, account_number)` to its `bank_account.id`, creating the row if missing.
// `config.banks` still owns which accounts exist + their credentials; this keeps the bank_account
// registry in sync so `bank_tx.bank_account_id` (a NOT NULL FK) can be stamped at scrape time. Ids
// are generated app-side by the schema's uuidv7 `$defaultFn`.
export async function ensureBankAccount(input: {
  bankKey: string;
  accountNumber: string;
  type: string;
}): Promise<string> {
  await db
    .insert(bankAccount)
    // `currency` is not in `input` because `config.banks` doesn't carry one — every tracked account
    // is USD (see the root CLAUDE.md). Stamping it here rather than leaving it null keeps the column
    // the single source of truth it's documented to be: without this, an account created by a scrape
    // got a null currency while the pre-existing rows all read 'USD'. If a non-USD account is ever
    // added, this needs to come from config instead.
    .values({ ...input, currency: 'USD' })
    .onConflictDoNothing({ target: [bankAccount.bankKey, bankAccount.accountNumber] });

  const row = await db.query.bankAccount.findFirst({
    where: (a, { and, eq }) =>
      and(eq(a.bankKey, input.bankKey), eq(a.accountNumber, input.accountNumber)),
    columns: { id: true },
  });
  if (!row) {
    throw new Error(
      `bank_account row missing after upsert for ${input.bankKey}/${input.accountNumber}`,
    );
  }
  return row.id;
}
