import { Kysely, PostgresDialect, type InsertObject } from 'kysely';
import { type DB } from 'kysely-codegen';
import { Pool } from 'pg';

export type { DB, InsertObject };

export const kysely = new Kysely<DB>({
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
