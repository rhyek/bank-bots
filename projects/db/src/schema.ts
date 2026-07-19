import {
  bigint,
  boolean,
  date,
  json,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Source of truth for the Supabase Postgres schema. Bootstrapped from the live DB via
// `drizzle-kit pull`, then curated. Evolve the DB by editing this file and running
// `drizzle-kit generate` + `drizzle-kit migrate` (see package.json db:* scripts).
//
// RLS: not used. Supabase enables row-level security by default, but this DB is reached only via a
// direct Postgres connection (DATABASE_URL), which bypasses RLS anyway; tables are kept with RLS
// disabled (the 0002 migration disabled it on the pre-existing bank_txs/config tables).
//
// Note on migration 0003: `drizzle-kit generate` can't resolve the `bank_txs -> bank_tx` rename
// without a TTY, so 0003 (rename + drop cols + NOT NULL + index swap + constraint/sequence renames,
// plus the bank_account seed & backfill) is hand-authored. Its snapshot was produced by transforming
// 0002's and validated by re-running `generate` (which reports no changes against this file).

// The canonical bank-account registry. `config.banks.<key>.accounts` still drives which accounts get
// scraped + the credentials; this table gives each `(bank_key, account_number)` a stable id that
// `bank_tx` (and transfers) reference. PG 15 has no `uuidv7()`, so ids are generated app-side.
export const bankAccount = pgTable(
  'bank_account',
  {
    id: uuid().primaryKey().$defaultFn(uuidv7),
    bankKey: text('bank_key').notNull(),
    accountNumber: text('account_number').notNull(),
    type: text().notNull(),
    currency: text(),
    // Ledger balance in cents, captured at scrape time: the last row's "Balance" on the current
    // month's statement (= Saldo disponible + Retenido). Reconcile against SUM(bank_tx.amount_cents).
    runningBalanceCents: bigint('running_balance_cents', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex('bank_account_unique_cols').on(table.bankKey, table.accountNumber)],
);

// Payees + categories imported from YNAB (ids are the YNAB uuids). Categories keep YNAB's
// group hierarchy via `category.group_id`.
export const payee = pgTable('payee', {
  id: text().primaryKey(),
  name: text().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const categoryGroup = pgTable('category_group', {
  id: text().primaryKey(),
  name: text().notNull(),
  hidden: boolean().notNull().default(false),
});

export const category = pgTable('category', {
  id: text().primaryKey(),
  name: text().notNull(),
  groupId: text('group_id')
    .notNull()
    .references(() => categoryGroup.id),
  hidden: boolean().notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const bankTx = pgTable(
  'bank_tx',
  {
    id: uuid().primaryKey().$defaultFn(uuidv7),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccount.id),
    month: text().notNull(),
    date: date({ mode: 'string' }).notNull(),
    docNo: text('doc_no').notNull(),
    description: text().notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    // Nullable mappings backfilled from YNAB; a transfer sets `transfer_bank_account_id` (the other
    // account) and leaves payee/category null.
    payeeId: text('payee_id').references(() => payee.id),
    categoryId: text('category_id').references(() => category.id),
    transferBankAccountId: uuid('transfer_bank_account_id').references(() => bankAccount.id),
    // Manual reconciliation rows: not present on any bank statement, so a scrape must never delete
    // them and payee/category matching must never target them. Replaces the old convention of
    // marking such rows with `doc_no = 'RECONCILE'`.
    reconcile: boolean().notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('bank_tx_unique_cols').on(
      table.bankAccountId,
      table.date,
      table.docNo,
      table.description,
      table.amountCents,
    ),
  ],
);

// Merchant patterns used by the tx-payees app's payee-resolver module to match an unmapped
// transaction to a payee + category. A rule only decides WHERE to look: the answer comes from the most recent
// already-mapped transaction whose description matches the pattern, never from the rule itself
// (a rule carrying a fixed payee would be the `forcePayee` behavior that was deliberately removed).
// Patterns are JS regex sources evaluated in SQLite against the replica — Postgres `~*` is POSIX and
// cannot express the negative lookahead some patterns rely on. Matching is case-insensitive.
export const matchingRule = pgTable(
  'matching_rule',
  {
    id: uuid().primaryKey().$defaultFn(uuidv7),
    label: text().notNull(),
    pattern: text().notNull(),
    priority: bigint({ mode: 'number' }).notNull(),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  // Unique so the seed script can upsert on label (onConflictDoUpdate needs a unique target).
  (table) => [uniqueIndex('matching_rule_label_unique').on(table.label)],
);

export const config = pgTable('config', {
  id: text().primaryKey().notNull(),
  data: json().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});
