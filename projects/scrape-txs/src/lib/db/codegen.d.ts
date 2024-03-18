import type { ColumnType } from "kysely";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;

export type Numeric = ColumnType<string, number | string, number | string>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface BankTxs {
  account_number: string;
  amount: Numeric;
  bank_key: string;
  created_at: Generated<Timestamp>;
  date: Timestamp;
  description: string;
  doc_no: string;
  id: Generated<Int8>;
  month: string;
  tx_key: string;
}

export interface DB {
  bank_txs: BankTxs;
}
