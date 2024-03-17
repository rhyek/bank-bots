import ynab, { type SaveTransaction, type SaveTransactionWithId } from 'ynab';
import dayjs from 'dayjs';
import Decimal from 'decimal.js';
import type { BankAccountWithTransactions } from '../../../types/types';

export type YnabConfig = {
  accessToken: string;
  budgetId: string;
  accountsMap: {
    bankKey: string;
    bankAccountNumber: string;
    ynabAccountId: string;
  }[];
};

function log(message: string, data: any) {
  console.log(`${message}:`, data);
}

export async function updateYnab({
  ynabConfig,
  bankKey,
  bankAccountsWithTransactions,
  dryRun,
}: {
  ynabConfig: YnabConfig;
  bankKey: string;
  bankAccountsWithTransactions: BankAccountWithTransactions[];
  dryRun: boolean;
}) {
  const api = new ynab.API(ynabConfig.accessToken);
  for (const {
    account: inputAccount,
    transactions: _bankTransactions,
  } of bankAccountsWithTransactions) {
    if (_bankTransactions.length === 0) {
      continue;
    }
    // 1 month before the first transaction
    const { year, month } = _bankTransactions[0];
    const since = dayjs()
      .year(year)
      .month(month - 2)
      .date(1)
      .startOf('day')
      .toISOString();
    const ynabAccountId = ynabConfig.accountsMap.find(
      (accountMap) =>
        accountMap.bankKey === bankKey &&
        accountMap.bankAccountNumber === inputAccount.number
    )!.ynabAccountId;
    const ynabTransactions = (
      await api.transactions.getTransactionsByAccount(
        ynabConfig.budgetId,
        ynabAccountId,
        since
      )
    ).data.transactions.map((ynabTx) => {
      const ref =
        (() => {
          try {
            return JSON.parse(ynabTx.memo ?? '').ref as string;
          } catch {
            return null;
          }
        })() ??
        /ref: (\d+);/.exec(ynabTx.memo ?? '')?.[1] ??
        null;
      return {
        ynabTx,
        parsedMemo: {
          ref,
        },
      };
    });
    const bankTransactions = _bankTransactions.map((tx) => ({
      ...tx,
      amount: new Decimal(tx.amount).times(1000).toNumber(),
    }));

    const ynabTxCreates: SaveTransaction[] = [];
    const ynabTxUpdates: SaveTransactionWithId[] = [];

    for (const bankTransaction of bankTransactions) {
      const ynabTxEntry = ynabTransactions.find(
        (tx) =>
          tx.parsedMemo.ref === bankTransaction.ref ||
          tx.parsedMemo.ref === bankTransaction.docNo
      );
      if (!ynabTxEntry) {
        log('Creating transaction', {
          bankAccount: inputAccount,
          bankTx: bankTransaction,
          ynabTx: null,
        });
        ynabTxCreates.push({
          account_id: ynabAccountId,
          date: dayjs()
            .year(bankTransaction.year)
            .month(bankTransaction.month - 1)
            .date(bankTransaction.date)
            .format('YYYY-MM-DD'),
          amount: bankTransaction.amount,
          memo: JSON.stringify({
            ref: bankTransaction.ref,
            desc: bankTransaction.description,
          }),
          cleared: 'cleared',
        });
      } else {
        const { ynabTx } = ynabTxEntry;

        if (ynabTx.approved) {
          continue;
        }

        type TxData = Omit<SaveTransactionWithId, 'id'>;
        const updateData: {
          before: TxData;
          after: TxData;
        } = {
          before: {},
          after: {},
        };

        if (ynabTx.amount !== bankTransaction.amount) {
          updateData.before.amount = ynabTx.amount;
          updateData.after.amount = bankTransaction.amount;
        }
        if (ynabTx.cleared === 'uncleared') {
          updateData.before.cleared = ynabTx.cleared;
          updateData.after.cleared = 'cleared';
        }

        if (Object.keys(updateData.after).length > 0) {
          log('Updating transaction', {
            bankAccount: inputAccount,
            bankTx: bankTransaction,
            ynabTx: {
              id: ynabTx.id,
              amount: ynabTx.amount,
              cleared: ynabTx.cleared,
              memo: ynabTx.memo ?? '',
            },
            updates: updateData,
          });
          ynabTxUpdates.push({
            id: ynabTx.id,
            ...updateData.after,
          });
        }
      }
    }
    if (!dryRun) {
      if (ynabTxCreates.length > 0) {
        await api.transactions.createTransactions(ynabConfig.budgetId, {
          transactions: ynabTxCreates,
        });
      }
      if (ynabTxUpdates.length > 0) {
        await api.transactions.updateTransactions(ynabConfig.budgetId, {
          transactions: ynabTxUpdates,
        });
      }
    }
    if (ynabTxCreates.length === 0 && ynabTxUpdates.length === 0) {
      console.log('No transactions to create or update');
    }
  }
}
