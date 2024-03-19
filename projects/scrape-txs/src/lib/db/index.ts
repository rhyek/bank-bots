import { Kysely, PostgresDialect, type InsertObject } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './codegen';

export type { DB, InsertObject };

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({
      connectionString: process.env.DATABASE_URL,
    }),
  }),
  // log(event): void {
  //   if (event.level === 'query') {
  //     console.log(event.query.sql);
  //     console.log(event.query.parameters);
  //   }
  // },
});
