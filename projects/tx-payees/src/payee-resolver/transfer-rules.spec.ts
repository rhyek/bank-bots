import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findTransfer,
  type TrackedAccount,
  type TransferContext,
  type TransferTx,
} from '~/payee-resolver/transfer-rules';

const CHECKING: TrackedAccount = {
  id: 'acct-checking',
  bankKey: 'bancoIndustrialGt',
  accountNumber: '3250000001',
};
const SAVINGS: TrackedAccount = {
  id: 'acct-savings',
  bankKey: 'bancoIndustrialGt',
  accountNumber: '3300007',
};
const BAC: TrackedAccount = { id: 'acct-bac', bankKey: 'bacGt', accountNumber: '900000001' };

let seq = 0;
function row(account: TrackedAccount, description: string, over: Partial<TransferTx> = {}) {
  return {
    id: `tx-${++seq}`,
    bankAccountId: account.id,
    date: '2026-10-04',
    docNo: '4230119',
    description,
    amountCents: -826267,
    ...over,
  } satisfies TransferTx;
}

function context(...rows: TransferTx[]): TransferContext {
  return {
    accounts: [CHECKING, SAVINGS, BAC],
    rowsOn: (accountId, date) =>
      rows.filter((r) => r.bankAccountId === accountId && r.date === date),
  };
}

test('a row naming another tracked account of the same bank is a transfer to it', () => {
  const inbound = row(CHECKING, 'BI-APP TRANSF DE CTA GT 3300007', { amountCents: 826267 });
  const outbound = row(SAVINGS, 'BANCA MOVIL');

  assert.deepEqual(findTransfer(inbound, context(inbound, outbound)), {
    rule: 'banco-industrial-named-account',
    otherAccountId: SAVINGS.id,
    partnerTxId: outbound.id,
  });
});

test('the side that names nobody is found through the row that names its account', () => {
  const inbound = row(CHECKING, 'BI-APP TRANSF DE CTA GT 3300007', { amountCents: 826267 });
  const outbound = row(SAVINGS, 'BANCA MOVIL');

  assert.deepEqual(findTransfer(outbound, context(inbound, outbound)), {
    rule: 'banco-industrial-named-account',
    otherAccountId: CHECKING.id,
    partnerTxId: inbound.id,
  });
});

test('the web banking wording, which pads the account number with 000', () => {
  const outbound = row(CHECKING, 'BELWEB TRANSF. PROPIA A 3300007000');

  assert.deepEqual(findTransfer(outbound, context(outbound)), {
    rule: 'banco-industrial-named-account',
    otherAccountId: SAVINGS.id,
    partnerTxId: null,
  });
});

test('a row naming a tracked account is a transfer even when its other side is not stored', () => {
  const inbound = row(CHECKING, 'BI-APP TRANSF DE CTA GT 3300007', { amountCents: 50000 });

  assert.equal(findTransfer(inbound, context(inbound))?.partnerTxId, null);
  assert.equal(findTransfer(inbound, context(inbound))?.otherAccountId, SAVINGS.id);
});

test('a transfer to an account that is not tracked is not a transfer', () => {
  const outbound = row(CHECKING, 'BI-APP TRANSF A CTA GT 1000002');

  assert.equal(findTransfer(outbound, context(outbound)), null);
});

test('a longer number that merely contains a tracked account number is not that account', () => {
  const outbound = row(CHECKING, 'BI-APP TRANSF A CTA GT 33000071');

  assert.equal(findTransfer(outbound, context(outbound)), null);
});

test('an opposite amount on the same day is not the other side without the document number', () => {
  const inbound = row(CHECKING, 'BI-APP TRANSF DE CTA GT 3300007', { amountCents: 826267 });
  const unrelated = row(SAVINGS, 'BANCA MOVIL', { docNo: '9999999' });

  assert.equal(findTransfer(unrelated, context(inbound, unrelated)), null);
  assert.equal(findTransfer(inbound, context(inbound, unrelated))?.partnerTxId, null);
});

test('a row with the same document number and amount is not the other side on another day', () => {
  const inbound = row(CHECKING, 'BI-APP TRANSF DE CTA GT 3300007', { amountCents: 826267 });
  const later = row(SAVINGS, 'BANCA MOVIL', { date: '2026-10-05' });

  assert.equal(findTransfer(later, context(inbound, later)), null);
});

test('two rows that could each be the other side leave it unpaired', () => {
  const inbound = row(CHECKING, 'BI-APP TRANSF DE CTA GT 3300007', { amountCents: 826267 });
  const first = row(SAVINGS, 'BANCA MOVIL');
  const second = row(SAVINGS, 'BANCA MOVIL');

  assert.equal(findTransfer(inbound, context(inbound, first, second))?.partnerTxId, null);
});

test('a row at another bank is not paired through a Banco Industrial row', () => {
  const inbound = row(CHECKING, 'BI-APP TRANSF DE CTA GT 900000001', { amountCents: 826267 });
  const outbound = row(BAC, 'TEF A : 123');

  assert.equal(findTransfer(outbound, context(inbound, outbound)), null);
  assert.equal(findTransfer(inbound, context(inbound, outbound)), null);
});
