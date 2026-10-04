import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// SQLite mirror of the three replicated Postgres tables. Kept intentionally close to the PG shape —
// the same camelCase property keys as @bank-bots/db, so a Postgres row upserts straight in with no
// remapping. Columns that reference tables we do NOT replicate (bank_account_id, group_id,
// transfer_bank_account_id) are plain text here: no FK, no join target. Timestamps are stored as the
// ISO text Postgres returns (mode:'string'), so max(updated_at) is a valid delta-sync watermark.

export const payee = sqliteTable('payee', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // Where the business is. `locationKind` NULL means the payee location matcher has not run yet.
  country: text('country'),
  location: text('location'),
  locationKind: text('location_kind'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Replicated so the AI tier can name a category's group in its prompt. It has to: the instructions
// forbid choosing anything in the "Events" group (date-scoped one-offs the owner assigns by hand),
// and create_category needs a real group id.
export const categoryGroup = sqliteTable('category_group', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hidden: integer('hidden', { mode: 'boolean' }).notNull(),
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
  // Where the owner was when the purchase happened — not where the payee is.
  country: text('country'),
  location: text('location'),
  reconcile: integer('reconcile', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Merchant patterns for payee-resolver. Selectors only — the payee/category come from matching history,
// never from the rule. Patterns are JS regex sources, evaluated by the regexp() function ReplicaDb
// registers on the connection.
export const matchingRule = sqliteTable('matching_rule', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  pattern: text('pattern').notNull(),
  priority: integer('priority').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Audit log of every matching decision. Replicated because payee-resolver's backlog sweep reads it
// locally: a `type = 'none'` row means "already asked, there is no answer", and excluding those is
// what stops permanently-unresolvable rows (inter-account transfers) from costing an agent call on
// every boot. `data` is the JSON text Postgres returns for the jsonb column.
//
// It also carries `type = 'location'` rows, one per transaction location lookup, whose `data.final`
// tells the sweep whether that lookup still needs redoing. A payee verdict query must filter on type.
export const matcherResult = sqliteTable('matcher_result', {
  id: text('id').primaryKey(),
  bankTxId: text('bank_tx_id').notNull(),
  type: text('type').notNull(),
  payeeId: text('payee_id'),
  categoryId: text('category_id'),
  sourceTxId: text('source_tx_id'),
  matchingRuleId: text('matching_rule_id'),
  data: text('data', { mode: 'json' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Applied at startup (create-if-not-exists). The replica is a disposable local cache, so there's no
// migration tooling — this DDL is the whole schema. Kept in sync with the drizzle tables above.
export const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payee (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT,
  location TEXT,
  location_kind TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS category_group (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hidden INTEGER NOT NULL,
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
  country TEXT,
  location TEXT,
  reconcile INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matching_rule (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matcher_result (
  id TEXT PRIMARY KEY,
  bank_tx_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payee_id TEXT,
  category_id TEXT,
  source_tx_id TEXT,
  matching_rule_id TEXT,
  data TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payee_updated_at ON payee (updated_at);
CREATE INDEX IF NOT EXISTS category_group_updated_at ON category_group (updated_at);
CREATE INDEX IF NOT EXISTS category_updated_at ON category (updated_at);
CREATE INDEX IF NOT EXISTS bank_tx_updated_at ON bank_tx (updated_at);
CREATE INDEX IF NOT EXISTS matching_rule_updated_at ON matching_rule (updated_at);
-- payee-resolver's hot paths: the backlog sweep filters on payee_id, and the exact tier looks up by
-- description.
CREATE INDEX IF NOT EXISTS bank_tx_payee_id ON bank_tx (payee_id);
CREATE INDEX IF NOT EXISTS bank_tx_description ON bank_tx (description);
CREATE INDEX IF NOT EXISTS matcher_result_updated_at ON matcher_result (updated_at);
-- The backlog sweep's skip check: "does this tx already have a terminal 'none' verdict?"
CREATE INDEX IF NOT EXISTS matcher_result_bank_tx_id ON matcher_result (bank_tx_id, type);
`;

// Applied when the stored user_version doesn't match EXPECTED_SCHEMA_VERSION. `CREATE TABLE IF NOT
// EXISTS` can't evolve an existing file, so a shape change means rebuilding: dropping empties the
// delta-sync watermark, and the next sync does a full re-pull. That's the intended recovery for a
// cache that is disposable by design.
export const DROP_SCHEMA_SQL = `
DROP TABLE IF EXISTS matcher_result;
DROP TABLE IF EXISTS matching_rule;
DROP TABLE IF EXISTS bank_tx;
DROP TABLE IF EXISTS category;
DROP TABLE IF EXISTS category_group;
DROP TABLE IF EXISTS payee;
`;
