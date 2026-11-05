// Recognising a transfer between two of the owner's own accounts.
//
// A transfer is never guessed from an amount and a date. That pairing linked a -$10,000 on one
// account to a +$10,000 on another a day later, which were two separate third-party movements.
// Every rule here names the evidence it rests on, and that evidence has to come from the bank's own
// rows: an account number in a description, a document number shared by both sides.
//
// To cover another bank or another wording, add a rule to TRANSFER_RULES, with a spec built from
// the real rows. Nothing else changes: PayeeResolver marks whatever a rule finds.

/** A row of `bank_account`: the accounts the scraper tracks. */
export interface TrackedAccount {
  id: string;
  bankKey: string;
  accountNumber: string;
}

/** What a rule may read of a transaction. */
export interface TransferTx {
  id: string;
  bankAccountId: string;
  date: string;
  docNo: string;
  description: string;
  amountCents: number;
}

export interface TransferContext {
  accounts: readonly TrackedAccount[];
  /** The bank rows of one account on one date. Never reconciliation rows. */
  rowsOn: (accountId: string, date: string) => TransferTx[];
}

export interface TransferFinding {
  /** The rule that decided it, for the audit log. */
  rule: string;
  /** The account on the other side. */
  otherAccountId: string;
  /** The other side's own row, when it is stored and can be told apart. */
  partnerTxId: string | null;
}

export interface TransferRule {
  name: string;
  find(tx: TransferTx, context: TransferContext): Omit<TransferFinding, 'rule'> | null;
}

/** Does the description carry this account's number, as a whole number of its own? */
function names(description: string, account: TrackedAccount): boolean {
  const numbers = description.match(/\d+/g) ?? [];
  // Bi en Línea's web wording pads the number: "BELWEB TRANSF. PROPIA A 3388707000".
  return numbers.some((n) => n === account.accountNumber || n === `${account.accountNumber}000`);
}

/**
 * Banco Industrial prints the other account's number on one side of a transfer between two of its
 * accounts ("BI-APP TRANSF DE CTA GT 3388707", "BELWEB TRANSF. PROPIA A 3388707000"), in the same
 * form `bank_account.account_number` stores it. A transfer to somebody else is worded the same way,
 * so the number matching a tracked account is what tells them apart, not the wording.
 *
 * The other side says only "BANCA MOVIL". It is the row on the named account with the same date,
 * the same document number and the opposite amount, and it is found from either side.
 */
const bancoIndustrialNamedAccount: TransferRule = {
  name: 'banco-industrial-named-account',
  find(tx, { accounts, rowsOn }) {
    const own = accounts.find((a) => a.id === tx.bankAccountId);
    if (own?.bankKey !== 'bancoIndustrialGt') {
      return null;
    }
    const others = accounts.filter((a) => a.bankKey === own.bankKey && a.id !== own.id);
    const otherSides = (account: TrackedAccount) =>
      rowsOn(account.id, tx.date).filter(
        (r) => r.docNo === tx.docNo && r.amountCents === -tx.amountCents,
      );

    const named = others.find((a) => names(tx.description, a));
    if (named) {
      const sides = otherSides(named);
      return { otherAccountId: named.id, partnerTxId: sides.length === 1 ? sides[0]!.id : null };
    }

    for (const other of others) {
      const sides = otherSides(other).filter((r) => names(r.description, own));
      if (sides.length === 1) {
        return { otherAccountId: other.id, partnerTxId: sides[0]!.id };
      }
    }
    return null;
  },
};

export const TRANSFER_RULES: readonly TransferRule[] = [bancoIndustrialNamedAccount];

/** The first rule that recognises the transaction as one side of a transfer, if any does. */
export function findTransfer(tx: TransferTx, context: TransferContext): TransferFinding | null {
  for (const rule of TRANSFER_RULES) {
    const found = rule.find(tx, context);
    if (found) {
      return { rule: rule.name, ...found };
    }
  }
  return null;
}
