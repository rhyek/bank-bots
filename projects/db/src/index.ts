import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Pass `schema` so the RQB (`db.query.bankTxs` / `db.query.config`) is available.
export const db = drizzle(pool, { schema });

export {
  bankAccount,
  bankTx,
  payee,
  categoryGroup,
  category,
  config,
  matchingRule,
  matcherResult,
  ownerDayLocation,
  payeeLocationResult,
  placeField,
  scrapeRun,
} from './schema';

export { keysetBefore, type TxCursor } from './keyset';

// This package owns the `uuid` dependency (see schema.ts, which uses it for uuidv7 primary keys).
// Re-exported so consumers minting an id app-side — e.g. the web app creating a payee — use the
// same generator rather than adding their own `uuid` dependency.
export { v7 as uuidv7 } from 'uuid';

// Re-export the drizzle-orm query helpers consumers need, so @bank-bots/db is the single owner of
// the drizzle-orm dependency. Importing drizzle-orm directly from a consumer creates a second
// physical instance under pnpm (its optional `pg` peer resolves differently), whose SQL types are
// "unrelated" to this package's — so consumers get their operators from here instead.
export {
  and,
  or,
  not,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  like,
  ilike,
  between,
  asc,
  desc,
  count,
  sql,
  sum,
  countDistinct,
  type SQL,
} from 'drizzle-orm';

// Same reasoning as above, for the pg-specific helpers. `alias` is needed by any consumer doing a
// self-join (e.g. resolving a transfer's counterpart account off `bank_tx`), and the table it
// returns must come from this package's drizzle instance to stay assignable to the query builder.
export { alias } from 'drizzle-orm/pg-core';
