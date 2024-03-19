import type { ColumnType } from "kysely";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;

export type Json = JsonValue;

export type JsonArray = JsonValue[];

export type JsonObject = {
  [K in string]?: JsonValue;
};

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

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

export interface Config {
  created_at: Generated<Timestamp>;
  data: Json;
  id: string;
}

export interface DB {
  bank_txs: BankTxs;
  config: Config;
}
