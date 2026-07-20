import { alias, bankAccount, bankTx, category, categoryGroup, db, eq, payee } from '@bank-bots/db';

/**
 * One transaction, with every foreign key already resolved to something displayable.
 *
 * Shared by the register and the spending page's drill-down so the two render identical rows. The
 * join set is wide enough that duplicating it would drift the first time a column was added to one
 * and not the other.
 */
export type TxRow = {
  id: string;
  date: string;
  description: string;
  amountCents: number;
  reconcile: boolean;
  accountId: string;
  accountLabel: string;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryGroupName: string | null;
  transferAccountLabel: string | null;
};

const transferAccount = alias(bankAccount, 'transfer_account');

/**
 * The joined base query. Callers add their own `where` / `orderBy` / `limit`.
 *
 * Every join but the account one is a LEFT join: a transaction need not have a payee, a category or
 * a transfer counterpart, and an INNER join would silently drop exactly the uncategorized rows the
 * spending page exists to surface.
 */
export function txRowQuery() {
  return db
    .select({
      id: bankTx.id,
      date: bankTx.date,
      description: bankTx.description,
      amountCents: bankTx.amountCents,
      reconcile: bankTx.reconcile,
      accountId: bankAccount.id,
      accountName: bankAccount.name,
      accountNumber: bankAccount.accountNumber,
      payeeId: bankTx.payeeId,
      payeeName: payee.name,
      categoryId: bankTx.categoryId,
      categoryName: category.name,
      categoryGroupName: categoryGroup.name,
      transferName: transferAccount.name,
      transferNumber: transferAccount.accountNumber,
    })
    .from(bankTx)
    .innerJoin(bankAccount, eq(bankTx.bankAccountId, bankAccount.id))
    .leftJoin(payee, eq(bankTx.payeeId, payee.id))
    .leftJoin(category, eq(bankTx.categoryId, category.id))
    .leftJoin(categoryGroup, eq(category.groupId, categoryGroup.id))
    .leftJoin(transferAccount, eq(bankTx.transferBankAccountId, transferAccount.id));
}

type RawTxRow = Awaited<ReturnType<typeof txRowQuery>>[number];

/** Collapses the account and transfer-account joins to a single display label each. */
export function mapTxRow(row: RawTxRow): TxRow {
  return {
    id: row.id,
    date: row.date,
    description: row.description,
    amountCents: row.amountCents,
    reconcile: row.reconcile,
    accountId: row.accountId,
    accountLabel: row.accountName ?? row.accountNumber,
    payeeId: row.payeeId,
    payeeName: row.payeeName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    categoryGroupName: row.categoryGroupName,
    transferAccountLabel: row.transferName ?? row.transferNumber,
  };
}
