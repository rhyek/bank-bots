import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// SQLite mirror of the three replicated Postgres tables. Kept intentionally close to the PG shape —
// the same camelCase property keys as @bank-bots/db, so a Postgres row upserts straight in with no
// remapping. Columns that reference tables we do NOT replicate (bank_account_id, group_id,
// transfer_bank_account_id) are plain text here: no FK, no join target. Timestamps are stored as the
// ISO text Postgres returns (mode:'string'), so max(updated_at) is a valid delta-sync watermark.

export const payee = sqliteTable('payee', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const category = sqliteTable('category', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  groupId: text('group_id').notNull(),
  hidden: integer('hidden', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const bankTx = sqliteTable('bank_tx', {
  id: text('id').primaryKey(),
  bankAccountId: text('bank_account_id').notNull(),
  month: text('month').notNull(),
  date: text('date').notNull(),
  docNo: text('doc_no').notNull(),
  description: text('description').notNull(),
  amountCents: integer('amount_cents').notNull(),
  payeeId: text('payee_id'),
  categoryId: text('category_id'),
  transferBankAccountId: text('transfer_bank_account_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Applied at startup (create-if-not-exists). The replica is a disposable local cache, so there's no
// migration tooling — this DDL is the whole schema. Kept in sync with the drizzle tables above.
export const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payee (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS category (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT NOT NULL,
  hidden INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_tx (
  id TEXT PRIMARY KEY,
  bank_account_id TEXT NOT NULL,
  month TEXT NOT NULL,
  date TEXT NOT NULL,
  doc_no TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  payee_id TEXT,
  category_id TEXT,
  transfer_bank_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payee_updated_at ON payee (updated_at);
CREATE INDEX IF NOT EXISTS category_updated_at ON category (updated_at);
CREATE INDEX IF NOT EXISTS bank_tx_updated_at ON bank_tx (updated_at);
`;
