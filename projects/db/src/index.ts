import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Pass `schema` so the RQB (`db.query.bankTxs` / `db.query.config`) is available.
export const db = drizzle(pool, { schema });

export { bankAccount, bankTx, payee, categoryGroup, category, config } from './schema';

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
} from 'drizzle-orm';
