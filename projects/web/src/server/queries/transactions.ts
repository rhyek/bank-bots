import {
  alias,
  and,
  bankAccount,
  bankTx,
  category,
  categoryGroup,
  db,
  desc,
  eq,
  gte,
  ilike,
  isNull,
  keysetBefore,
  lte,
  or,
  payee,
  type TxCursor,
} from '@bank-bots/db';
import { resolveWindow, type TxFilters } from '~/lib/filters';

export type TxRow = {
  id: string;
  date: string;
  description: string;
  memo: string | null;
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

export type TxPage = { rows: TxRow[]; nextCursor: string | null };

/**
 * The cursor crosses the wire as opaque base64 so the sort key can change later without breaking
 * cursors already held by a client.
 */
const encodeCursor = (cursor: TxCursor) =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeCursor = (raw: string | null): TxCursor | null =>
  raw ? (JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as TxCursor) : null;

export async function listTransactionsQuery(input: {
  filters: TxFilters;
  cursor: string | null;
  pageSize: number;
}): Promise<TxPage> {
  const { filters, pageSize } = input;
  const transferAccount = alias(bankAccount, 'transfer_account');
  const range = resolveWindow(filters);
  const search = filters.search?.trim();

  const conditions = [
    keysetBefore(decodeCursor(input.cursor)),
    range && gte(bankTx.date, range.from),
    range && lte(bankTx.date, range.to),
    filters.accountId && eq(bankTx.bankAccountId, filters.accountId),
    filters.unmatchedOnly && isNull(bankTx.payeeId),
    search &&
      or(
        ilike(bankTx.description, `%${search}%`),
        ilike(payee.name, `%${search}%`),
        ilike(bankTx.memo, `%${search}%`),
      ),
  ].filter((condition) => !!condition);

  // Fetch one extra row: its presence is the has-more signal, which avoids a final empty
  // round-trip at the end of an infinite scroll.
  const rows = await db
    .select({
      id: bankTx.id,
      date: bankTx.date,
      description: bankTx.description,
      memo: bankTx.memo,
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
    .leftJoin(transferAccount, eq(bankTx.transferBankAccountId, transferAccount.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(bankTx.date), desc(bankTx.id))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page.at(-1);

  return {
    rows: page.map((row) => ({
      id: row.id,
      date: row.date,
      description: row.description,
      memo: row.memo,
      amountCents: Number(row.amountCents),
      reconcile: row.reconcile,
      accountId: row.accountId,
      accountLabel: row.accountName ?? row.accountNumber,
      payeeId: row.payeeId,
      payeeName: row.payeeName,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      categoryGroupName: row.categoryGroupName,
      transferAccountLabel: row.transferName ?? row.transferNumber,
    })),
    nextCursor: hasMore && last ? encodeCursor({ date: last.date, id: last.id }) : null,
  };
}
