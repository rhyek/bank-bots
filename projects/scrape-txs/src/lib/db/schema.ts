import {
  bigint,
  date,
  json,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Source of truth for the Supabase Postgres schema. Bootstrapped from the live DB via
// `drizzle-kit pull`, then curated. Evolve the DB by editing this file and running
// `drizzle-kit generate` + `drizzle-kit migrate` (see package.json db:* scripts).
//
// RLS is enabled on both tables in the DB (Supabase default). We declare `.enableRLS()` so
// drizzle-kit doesn't try to disable it on the next diff; we don't otherwise manage policies here.

export const bankTxs = pgTable(
  'bank_txs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedByDefaultAsIdentity(),
    bankKey: text('bank_key').notNull(),
    accountNumber: text('account_number').notNull(),
    month: text().notNull(),
    date: date({ mode: 'string' }).notNull(),
    docNo: text('doc_no').notNull(),
    description: text().notNull(),
    amount: numeric({ mode: 'number' }).notNull(),
    currency: text().notNull().default('USD'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('bank_txs_unique_cols').on(
      table.bankKey,
      table.accountNumber,
      table.date,
      table.docNo,
      table.description,
      table.amount,
    ),
  ],
).enableRLS();

export const config = pgTable('config', {
  id: text().primaryKey().notNull(),
  data: json().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}).enableRLS();
