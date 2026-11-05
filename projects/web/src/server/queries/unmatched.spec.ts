import { bankAccount, bankTx, db, eq } from '@bank-bots/db';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { unmatchedCountQuery } from './payees';
import { listTransactionsQuery } from './transactions';

/**
 * What counts as "unmatched": a transaction still waiting for a payee. A transfer between two of
 * the owner's accounts has none and never will, so it is not one.
 *
 * Two fixture rows of this suite's own, neither with a payee: an ordinary one and one marked as a
 * transfer. Like the update suite's fixture, they sit in a far-past month under a marker doc
 * number, and a run sweeps whatever an interrupted one left behind.
 */
const FIXTURE_DOC_NO = 'TEST-UNMATCHED-FIXTURE';
const MARKER = 'unmatched test fixture';

let countBefore: number;
let ordinaryId: string;

async function insertFixture(description: string, transferBankAccountId: string | null) {
  const [account] = await db.select({ id: bankAccount.id }).from(bankAccount).limit(1);
  const [row] = await db
    .insert(bankTx)
    .values({
      bankAccountId: account.id,
      month: '2000-01',
      date: '2000-01-01',
      docNo: FIXTURE_DOC_NO,
      description,
      amountCents: -12345,
      transferBankAccountId,
    })
    .returning({ id: bankTx.id });
  return row.id;
}

beforeAll(async () => {
  await db.delete(bankTx).where(eq(bankTx.docNo, FIXTURE_DOC_NO));
  countBefore = await unmatchedCountQuery();

  const [other] = await db.select({ id: bankAccount.id }).from(bankAccount).limit(1).offset(1);
  ordinaryId = await insertFixture(`${MARKER}: ordinary`, null);
  await insertFixture(`${MARKER}: transfer`, other.id);
});

afterAll(async () => {
  await db.delete(bankTx).where(eq(bankTx.docNo, FIXTURE_DOC_NO));
});

test('the unmatched count leaves out a transfer', async () => {
  expect(await unmatchedCountQuery()).toBe(countBefore + 1);
});

test('the unmatched filter leaves out a transfer', async () => {
  const page = await listTransactionsQuery({
    filters: { window: 'all', unmatchedOnly: true, search: MARKER },
    cursor: null,
    pageSize: 10,
  });

  expect(page.rows.map((row) => row.id)).toEqual([ordinaryId]);
});
