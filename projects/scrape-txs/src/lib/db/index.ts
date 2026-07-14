import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Pass `schema` so the RQB (`db.query.bankTxs` / `db.query.config`) is available.
export const db = drizzle(pool, { schema });

export { bankTxs, config } from './schema';
