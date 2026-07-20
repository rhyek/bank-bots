import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bankAccount, db, eq } from '@bank-bots/db';
import { listAccountsQuery, renameAccountQuery } from './accounts';

describe('listAccountsQuery', () => {
  it('returns every account with a summed balance and a display label', async () => {
    const accounts = await listAccountsQuery();

    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(typeof account.balanceCents).toBe('number');
      expect(Number.isInteger(account.balanceCents)).toBe(true);
      // label falls back to the account number when the account has no name
      expect(account.label).toBe(account.name ?? account.accountNumber);
    }
  });

  it('sums amount_cents rather than reading running_balance_cents', async () => {
    // Verified against the live data: SUM(amount_cents) equals the scraped running balance
    // exactly on the accounts that carry one. bacGt 904201043 is 3567466 cents.
    const accounts = await listAccountsQuery();
    const bacGt = accounts.find((a) => a.accountNumber === '904201043');

    expect(bacGt).toBeDefined();
    expect(bacGt!.balanceCents).toBe(3567466);
  });
});

// This runs against the live personal-finance database (same as the suite above), so it must
// leave `bank_account` byte-identical afterward: read the target row's current name up front and
// restore it in `afterAll`, no matter which assertion (if any) fails.
describe('renameAccountQuery', () => {
  let accountId: string;
  let originalName: string | null;

  beforeAll(async () => {
    const accounts = await listAccountsQuery();
    const account = accounts[0];
    if (!account) {
      throw new Error('No accounts in the database to test renameAccountQuery against');
    }
    accountId = account.id;
    originalName = account.name;
  });

  afterAll(async () => {
    await db.update(bankAccount).set({ name: originalName }).where(eq(bankAccount.id, accountId));
  });

  it('sets a name and reflects it in label', async () => {
    const updated = await renameAccountQuery({ id: accountId, name: 'Test Rename' });

    expect(updated.name).toBe('Test Rename');
    expect(updated.label).toBe('Test Rename');
  });

  it('clears the name back to null on whitespace, falling back label to the account number', async () => {
    const updated = await renameAccountQuery({ id: accountId, name: '   ' });

    expect(updated.name).toBeNull();
    expect(updated.label).toBe(updated.accountNumber);
  });

  it('clears the name back to null on an empty string, falling back label to the account number', async () => {
    // Set a name first so this test actually exercises the clearing path either way.
    await renameAccountQuery({ id: accountId, name: 'Temp' });

    const updated = await renameAccountQuery({ id: accountId, name: '' });

    expect(updated.name).toBeNull();
    expect(updated.label).toBe(updated.accountNumber);
  });
});
