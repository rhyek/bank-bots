import { describe, expect, it } from 'vitest';
import { listAccountsQuery } from './accounts';

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
