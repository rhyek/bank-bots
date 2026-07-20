import { bankAccount, bankTx, db, eq, sql } from '@bank-bots/db';

export type AccountSummary = {
  id: string;
  bankKey: string;
  accountNumber: string;
  name: string | null;
  /** What the UI shows: the user-set name, falling back to the raw account number. */
  label: string;
  currency: string | null;
  balanceCents: number;
};

/**
 * Every account with its balance.
 *
 * The balance is `SUM(amount_cents)`, not `bank_account.running_balance_cents`. Summing is both
 * more available (running_balance_cents is null on two of the four accounts) and verified correct:
 * where both exist they agree exactly, because the full history is scraped.
 */
export async function listAccountsQuery(): Promise<AccountSummary[]> {
  const rows = await db
    .select({
      id: bankAccount.id,
      bankKey: bankAccount.bankKey,
      accountNumber: bankAccount.accountNumber,
      name: bankAccount.name,
      currency: bankAccount.currency,
      // COALESCE so an account with no transactions reports 0 rather than null.
      balanceCents: sql<number>`coalesce(sum(${bankTx.amountCents}), 0)::bigint`,
    })
    .from(bankAccount)
    .leftJoin(bankTx, eq(bankTx.bankAccountId, bankAccount.id))
    .groupBy(bankAccount.id)
    .orderBy(bankAccount.bankKey, bankAccount.accountNumber);

  return rows.map((row) => ({
    ...row,
    balanceCents: Number(row.balanceCents),
    label: row.name ?? row.accountNumber,
  }));
}

export async function renameAccountQuery(input: {
  id: string;
  name: string | null;
}): Promise<AccountSummary> {
  // Empty/whitespace-only clears the name so the UI falls back to the account number.
  const name = input.name?.trim() ? input.name.trim() : null;

  const [updated] = await db
    .update(bankAccount)
    .set({ name })
    .where(eq(bankAccount.id, input.id))
    .returning({
      id: bankAccount.id,
      bankKey: bankAccount.bankKey,
      accountNumber: bankAccount.accountNumber,
      name: bankAccount.name,
      currency: bankAccount.currency,
    });

  if (!updated) {
    throw new Error(`No bank account with id ${input.id}`);
  }

  const accounts = await listAccountsQuery();
  return accounts.find((a) => a.id === updated.id)!;
}
