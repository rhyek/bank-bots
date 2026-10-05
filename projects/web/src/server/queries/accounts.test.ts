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
    // The seed gives bacGt 904201043 rows summing to 3567466 cents and a running_balance_cents of
    // 100, so only the sum can produce this number (projects/db/seed/test-data.ts, SEED_FACTS).
    const accounts = await listAccountsQuery();
    const bacGt = accounts.find((a) => a.accountNumber === '904201043');

    expect(bacGt).toBeDefined();
    expect(bacGt!.balanceCents).toBe(3567466);
  });
});

// It operates on a dedicated fixture account it inserts and deletes — never a seeded one — so the
// suite above keeps seeing the seed's accounts untouched. The marker bank_key/account_number keep
// the fixture unmistakable and let the next run sweep one an interrupted run left behind.
const FIXTURE_BANK_KEY = 'test-fixture';

describe('renameAccountQuery', () => {
  let accountId: string;

  beforeAll(async () => {
    await db.delete(bankAccount).where(eq(bankAccount.bankKey, FIXTURE_BANK_KEY));
    const [row] = await db
      .insert(bankAccount)
      .values({
        bankKey: FIXTURE_BANK_KEY,
        accountNumber: 'TEST-RENAME-FIXTURE',
        type: 'checking',
        currency: 'USD',
      })
      .returning({ id: bankAccount.id });
    accountId = row.id;
  });

  afterAll(async () => {
    await db.delete(bankAccount).where(eq(bankAccount.bankKey, FIXTURE_BANK_KEY));
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
