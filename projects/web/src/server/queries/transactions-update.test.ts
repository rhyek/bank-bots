import { bankTx, db, eq, isNotNull } from '@bank-bots/db';
import { afterAll, describe, expect, it } from 'vitest';
import { listTransactionsQuery, updateTransactionQuery } from './transactions';

/**
 * These tests mutate the REAL database — this project has no test database. Every test captures the
 * target row's prior values up front and registers a restore, so the data is byte-identical
 * afterwards. Restores run in `afterAll` even if an expectation fails mid-test.
 */
describe('updateTransactionQuery', () => {
  const restores: (() => Promise<unknown>)[] = [];

  afterAll(async () => {
    for (const restore of restores) {
      await restore();
    }
  });

  async function claimRow() {
    const { rows } = await listTransactionsQuery({
      filters: { window: 'all' },
      cursor: null,
      pageSize: 1,
    });
    const [row] = await db.select().from(bankTx).where(eq(bankTx.id, rows[0].id));

    restores.push(() =>
      db
        .update(bankTx)
        .set({ payeeId: row.payeeId, categoryId: row.categoryId })
        .where(eq(bankTx.id, row.id)),
    );

    return row;
  }

  /** Any real payee id, so the FK on bank_tx.payee_id is satisfied. */
  async function somePayeeId() {
    const [row] = await db
      .select({ payeeId: bankTx.payeeId })
      .from(bankTx)
      .where(isNotNull(bankTx.payeeId))
      .limit(1);
    return row.payeeId!;
  }

  it('writes the payee and leaves the scraper natural key untouched', async () => {
    const before = await claimRow();
    const payeeId = await somePayeeId();

    const updated = await updateTransactionQuery({ id: before.id, payeeId });
    expect(updated.payeeId).toBe(payeeId);

    const [after] = await db.select().from(bankTx).where(eq(bankTx.id, before.id));

    // The five columns of bank_tx_unique_cols must be byte-identical: the scraper matches rows on
    // them, so a change here would duplicate this transaction on the next scrape of its month.
    expect(after.bankAccountId).toBe(before.bankAccountId);
    expect(after.date).toBe(before.date);
    expect(after.docNo).toBe(before.docNo);
    expect(after.description).toBe(before.description);
    expect(after.amountCents).toBe(before.amountCents);
  });

  it('clears a field when passed null, and leaves omitted fields alone', async () => {
    const before = await claimRow();
    const payeeId = await somePayeeId();

    await updateTransactionQuery({ id: before.id, payeeId });
    const cleared = await updateTransactionQuery({ id: before.id, categoryId: null });

    expect(cleared.categoryId).toBeNull();
    // payeeId was not in the second call's input, so it must survive it.
    expect(cleared.payeeId).toBe(payeeId);
  });

  it('rejects a call with nothing to update', async () => {
    const before = await claimRow();
    await expect(updateTransactionQuery({ id: before.id })).rejects.toThrow(/nothing to update/);
  });

  it('rejects an unknown transaction id', async () => {
    await expect(
      updateTransactionQuery({ id: '00000000-0000-7000-8000-000000000000', payeeId: null }),
    ).rejects.toThrow(/No transaction with id/);
  });
});
