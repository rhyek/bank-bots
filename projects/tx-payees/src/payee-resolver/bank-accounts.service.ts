import { bankAccount as pgBankAccount, db as pgDb } from '@bank-bots/db';
import { Injectable } from '@nestjs/common';
import type { TrackedAccount } from '~/payee-resolver/transfer-rules';

/**
 * The accounts the scraper tracks, read from Postgres: `bank_account` is not replicated.
 *
 * Read once per batch of work and kept until the queue drains (`reset`), so a sweep over a year of
 * transactions costs one query, and an account the scraper adds is seen by the next batch.
 */
@Injectable()
export class BankAccounts {
  private cached: TrackedAccount[] | undefined;

  async all(): Promise<TrackedAccount[]> {
    this.cached ??= await pgDb
      .select({
        id: pgBankAccount.id,
        bankKey: pgBankAccount.bankKey,
        accountNumber: pgBankAccount.accountNumber,
      })
      .from(pgBankAccount);
    return this.cached;
  }

  reset() {
    this.cached = undefined;
  }
}
