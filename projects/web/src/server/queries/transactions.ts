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
  /** Narrow to one transaction. Used to re-read a single row after an update, so the caller gets
   *  the fully-joined shape (payee name, category group, account label) rather than raw ids. */
  onlyId?: string;
}): Promise<TxPage> {
  const { filters, pageSize } = input;
  const transferAccount = alias(bankAccount, 'transfer_account');
  const range = resolveWindow(filters);
  const search = filters.search?.trim();

  const conditions = [
    input.onlyId && eq(bankTx.id, input.onlyId),
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

/**
 * Updates a transaction's payee, category and/or memo.
 *
 * These are the ONLY writable columns on `bank_tx`. `bank_account_id`, `date`, `doc_no`,
 * `description` and `amount_cents` form `bank_tx_unique_cols` — the scraper's upsert conflict
 * target and the match key of its delete pass (projects/scrape-txs/src/lib/bac/scrape.ts). Changing
 * any of them here would, on the next scrape of that month, re-insert the original row as a
 * duplicate AND delete this one. The row editor renders them read-only for the same reason.
 * Do not widen this set without changing scrape-txs to match.
 *
 * Uses `'key' in input` rather than a truthiness check so that explicitly passing `null` clears a
 * field, while omitting it leaves the column untouched.
 */
export async function updateTransactionQuery(input: {
  id: string;
  payeeId?: string | null;
  categoryId?: string | null;
  memo?: string | null;
}): Promise<TxRow> {
  const patch: Partial<{
    payeeId: string | null;
    categoryId: string | null;
    memo: string | null;
  }> = {};

  if ('payeeId' in input) {
    patch.payeeId = input.payeeId ?? null;
  }
  if ('categoryId' in input) {
    patch.categoryId = input.categoryId ?? null;
  }
  if ('memo' in input) {
    patch.memo = input.memo?.trim() ? input.memo.trim() : null;
  }

  if (Object.keys(patch).length === 0) {
    throw new Error('updateTransactionQuery called with nothing to update');
  }

  const [updated] = await db
    .update(bankTx)
    .set(patch)
    .where(eq(bankTx.id, input.id))
    .returning({ id: bankTx.id });

  if (!updated) {
    throw new Error(`No transaction with id ${input.id}`);
  }

  const page = await listTransactionsQuery({
    filters: { window: 'all' },
    cursor: null,
    pageSize: 1,
    onlyId: input.id,
  });

  return page.rows[0];
}
