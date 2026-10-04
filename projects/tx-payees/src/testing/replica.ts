import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '~/replica-db/replica-schema';
import type { ReplicaDb } from '~/replica-db/replica-db.service';

/**
 * An in-memory stand-in for ReplicaDb, set up the way ReplicaDb.onModuleInit does it: create the
 * schema and register regexp(). Without that function every REGEXP query fails at prepare().
 */
export function makeReplica(): ReplicaDb {
  const sqlite = new Database(':memory:');
  sqlite.exec(schema.CREATE_SCHEMA_SQL);
  sqlite.function('regexp', (pattern: string, value: string) =>
    value != null && new RegExp(pattern, 'i').test(value) ? 1 : 0,
  );
  return { raw: sqlite, db: drizzle(sqlite, { schema }) } as unknown as ReplicaDb;
}

const STAMP = '2026-07-01T00:00:00Z';
let seq = 0;

/** Ids ascend with insertion, mirroring uuidv7 — so "most recent" tiebreaks as in production. */
export function nextId(prefix: string): string {
  return `${prefix}-${String(++seq).padStart(5, '0')}`;
}

export function addPayee(
  replica: ReplicaDb,
  name: string,
  place: { locationKind?: string | null; country?: string | null; location?: string | null } = {},
): string {
  const id = nextId('payee');
  replica.db
    .insert(schema.payee)
    .values({ id, name, ...place, createdAt: STAMP, updatedAt: STAMP })
    .run();
  return id;
}

export function addTx(
  replica: ReplicaDb,
  description: string,
  opts: Partial<typeof schema.bankTx.$inferInsert> = {},
): string {
  const id = nextId('tx');
  const date = opts.date ?? '2026-07-01';
  replica.db
    .insert(schema.bankTx)
    .values({
      id,
      bankAccountId: 'acct-1',
      month: date.slice(0, 7),
      date,
      docNo: 'D1',
      description,
      amountCents: -1000,
      reconcile: false,
      createdAt: STAMP,
      updatedAt: STAMP,
      ...opts,
    })
    .run();
  return id;
}

export function addResult(
  replica: ReplicaDb,
  bankTxId: string,
  type: string,
  data: unknown = null,
): string {
  const id = nextId('result');
  replica.db
    .insert(schema.matcherResult)
    .values({ id, bankTxId, type, data, createdAt: STAMP, updatedAt: STAMP })
    .run();
  return id;
}
