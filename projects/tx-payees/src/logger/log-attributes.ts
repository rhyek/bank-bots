// The attributes this app logs from more than one place, given one spelling and one type each so
// a query on `txId` finds every line about a transaction. Anything else is still accepted on a log
// call; this only pins down the names that recur.
declare module '@rhyek/nestjs-utils' {
  interface LogAttributes {
    /** `bank_tx.id`. */
    txId?: string;
    /** `payee.id`. */
    payeeId?: string;
    /** A replicated table's name, e.g. `bank_tx`. */
    table?: string;
    /** A transaction's bank description. */
    description?: string;
  }
}

export {};
