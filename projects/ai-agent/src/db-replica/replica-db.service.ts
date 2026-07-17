import fs from 'node:fs';
import path from 'node:path';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '~/db-replica/replica-schema';

// Owns the better-sqlite3 connection + its (typed) Drizzle instance for the local replica cache.
// Opens the file and creates the schema (if absent) on init; the file persists across restarts, so
// a hot-reload boot reuses the existing cache rather than rebuilding it.
@Injectable()
export class ReplicaDb implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReplicaDb.name);
  private sqlite!: Database.Database;
  db!: BetterSQLite3Database<typeof schema>;

  onModuleInit() {
    const dbPath =
      process.env.REPLICA_DB_PATH ?? path.join(process.cwd(), 'storage', 'replica.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL'); // concurrent reads while the sync writes
    this.sqlite.exec(schema.CREATE_SCHEMA_SQL);
    this.db = drizzle(this.sqlite, { schema });
    this.logger.log(`SQLite replica ready at ${dbPath}`);
  }

  /** Raw better-sqlite3 handle — used to wrap bulk upserts in a single transaction. */
  get raw(): Database.Database {
    return this.sqlite;
  }

  onModuleDestroy() {
    this.sqlite?.close();
  }
}
