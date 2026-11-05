import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { BankAccounts } from '~/payee-resolver/bank-accounts.service';
import { findTransfer, type TransferTx } from '~/payee-resolver/transfer-rules';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import { bankTx } from '~/replica-db/replica-schema';

/** One side of a transfer, as it is to be written: the transaction and the account it points at. */
export interface TransferLeg {
  txId: string;
  otherAccountId: string;
  /** The other side's own row, when the rule could tell which one it is. */
  partnerTxId: string | null;
}

export interface Transfer {
  rule: string;
  legs: TransferLeg[];
}

const TRANSFER_TX = {
  id: bankTx.id,
  bankAccountId: bankTx.bankAccountId,
  date: bankTx.date,
  docNo: bankTx.docNo,
  description: bankTx.description,
  amountCents: bankTx.amountCents,
};

/**
 * Runs the transfer rules against the replica. The rules themselves, and what counts as evidence
 * of a transfer, are in transfer-rules.ts.
 */
@Injectable()
export class TransferMatcher {
  constructor(
    private readonly replica: ReplicaDb,
    private readonly accounts: BankAccounts,
  ) {}

  /**
   * The transfer this transaction is one side of, if a rule recognises it: the transaction's own
   * leg and, when the other side's row is known, that one's too. A partner already pointing at this
   * transaction's account is left out, so a side marked on its own earlier (its partner had not
   * been scraped, or had not reached the replica) is not written a second time.
   */
  async find(tx: TransferTx): Promise<Transfer | null> {
    const found = findTransfer(tx, {
      accounts: await this.accounts.all(),
      rowsOn: (accountId, date) =>
        this.replica.db
          .select(TRANSFER_TX)
          .from(bankTx)
          .where(
            and(
              eq(bankTx.bankAccountId, accountId),
              eq(bankTx.date, date),
              eq(bankTx.reconcile, false),
            ),
          )
          .all(),
    });
    if (!found) {
      return null;
    }
    const legs: TransferLeg[] = [
      { txId: tx.id, otherAccountId: found.otherAccountId, partnerTxId: found.partnerTxId },
    ];
    if (found.partnerTxId && this.transferAccountOf(found.partnerTxId) !== tx.bankAccountId) {
      legs.push({ txId: found.partnerTxId, otherAccountId: tx.bankAccountId, partnerTxId: tx.id });
    }
    return { rule: found.rule, legs };
  }

  /** Every bank row since `fromDate` not yet marked as a transfer, for a sweep to check. */
  unmarkedSince(fromDate: string): TransferTx[] {
    return this.replica.db
      .select(TRANSFER_TX)
      .from(bankTx)
      .where(
        and(
          isNull(bankTx.transferBankAccountId),
          eq(bankTx.reconcile, false),
          sql`${bankTx.date} >= ${fromDate}`,
        ),
      )
      .all();
  }

  /** Forget the accounts read so far. Called when the work queue drains. */
  reset() {
    this.accounts.reset();
  }

  private transferAccountOf(txId: string): string | null {
    return (
      this.replica.db
        .select({ account: bankTx.transferBankAccountId })
        .from(bankTx)
        .where(eq(bankTx.id, txId))
        .get()?.account ?? null
    );
  }
}
