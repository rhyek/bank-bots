import { bankAccount, bankTx, db, eq, isNotNull } from '@bank-bots/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { updateTransactionQuery } from './transactions';

/**
 * These tests exercise a real write against the real database — this project has no test database.
 *
 * They operate on a dedicated fixture row this suite inserts and deletes, NEVER a live transaction.
 * An earlier version claimed "the newest transaction" and restored it afterwards; when the newest
 * happened to be a manual reconcile row and a run was interrupted before the restore, it left a
 * bogus payee stamped on real data. A disposable, clearly-labelled fixture removes that whole class
 * of hazard: the worst an interrupted run can leave behind is one row that the next run sweeps.
 *
 * `reconcile: true` keeps a live scrape from ever deleting the fixture mid-run; the far-past date
 * and marker doc number keep it out of every default view and make it unmistakable.
 */
const FIXTURE_DOC_NO = 'TEST-UPDATE-FIXTURE';

const FIXTURE = {
  month: '2000-01',
  date: '2000-01-01',
  docNo: FIXTURE_DOC_NO,
  description: 'updateTransactionQuery test fixture — safe to delete',
  amountCents: -12345,
  reconcile: true,
} as const;

describe('updateTransactionQuery', () => {
  let fixtureId: string;
  let payeeId: string;

  async function insertFixture(): Promise<string> {
    const [account] = await db.select({ id: bankAccount.id }).from(bankAccount).limit(1);
    const [row] = await db
      .insert(bankTx)
      .values({ bankAccountId: account.id, ...FIXTURE })
      .returning({ id: bankTx.id });
    return row.id;
  }

  beforeAll(async () => {
    // Sweep any fixture a previously-interrupted run left behind, then create a clean one.
    await db.delete(bankTx).where(eq(bankTx.docNo, FIXTURE_DOC_NO));
    fixtureId = await insertFixture();

    // Any real payee id, so the FK on bank_tx.payee_id is satisfied by the write tests.
    const [somePayee] = await db
      .select({ id: bankTx.payeeId })
      .from(bankTx)
      .where(isNotNull(bankTx.payeeId))
      .limit(1);
    payeeId = somePayee.id!;
  });

  afterAll(async () => {
    await db.delete(bankTx).where(eq(bankTx.docNo, FIXTURE_DOC_NO));
  });

  // Reset to a known clean state so each test is independent of the previous one's writes.
  beforeEach(async () => {
    await db
      .update(bankTx)
      .set({ payeeId: null, categoryId: null })
      .where(eq(bankTx.id, fixtureId));
  });

  it('writes the payee and leaves the scraper natural key untouched', async () => {
    const updated = await updateTransactionQuery({ id: fixtureId, payeeId });
    expect(updated.payeeId).toBe(payeeId);

    const [after] = await db.select().from(bankTx).where(eq(bankTx.id, fixtureId));

    // The five columns of bank_tx_unique_cols must be byte-identical: the scraper matches rows on
    // them, so a change here would duplicate this transaction on the next scrape of its month.
    expect(after.date).toBe(FIXTURE.date);
    expect(after.docNo).toBe(FIXTURE.docNo);
    expect(after.description).toBe(FIXTURE.description);
    expect(after.amountCents).toBe(FIXTURE.amountCents);
    // bankAccountId is set from an existing account at insert; the update must not have touched it.
    expect(after.bankAccountId).toBeTruthy();
  });

  it('clears a field when passed null, and leaves omitted fields alone', async () => {
    await updateTransactionQuery({ id: fixtureId, payeeId });
    const cleared = await updateTransactionQuery({ id: fixtureId, categoryId: null });

    expect(cleared.categoryId).toBeNull();
    // payeeId was not in the second call's input, so it must survive it.
    expect(cleared.payeeId).toBe(payeeId);
  });

  it('rejects a call with nothing to update', async () => {
    await expect(updateTransactionQuery({ id: fixtureId })).rejects.toThrow(/nothing to update/);
  });

  it('rejects an unknown transaction id', async () => {
    await expect(
      updateTransactionQuery({ id: '00000000-0000-7000-8000-000000000000', payeeId: null }),
    ).rejects.toThrow(/No transaction with id/);
  });
});
