import fs from 'node:fs';
import path from 'node:path';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '~/replica-db/replica-schema';

// Bump whenever replica-schema.ts changes shape. Files written before this stamp existed read 0,
// so they rebuild on first boot.
const EXPECTED_SCHEMA_VERSION = 3;

// Owns the better-sqlite3 connection + its (typed) Drizzle instance for the local replica cache.
// Opens the file and creates the schema (if absent) on init; the file persists across restarts, so
// a hot-reload boot reuses the existing cache rather than rebuilding it.
@Injectable()
export class ReplicaDb implements OnModuleInit, OnModuleDestroy {
  private sqlite!: Database.Database;
  db!: BetterSQLite3Database<typeof schema>;

  constructor(private readonly logger: StructuredLoggerService) {}

  onModuleInit() {
    const dbPath =
      process.env.REPLICA_DB_PATH ?? path.join(process.cwd(), 'storage', 'replica.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL'); // concurrent reads while the sync writes

    const version = this.sqlite.pragma('user_version', { simple: true }) as number;
    if (version !== EXPECTED_SCHEMA_VERSION) {
      this.logger.info(
        { version, expectedVersion: EXPECTED_SCHEMA_VERSION },
        'replica schema version changed; rebuilding',
      );
      this.sqlite.exec(schema.DROP_SCHEMA_SQL);
    }
    this.sqlite.exec(schema.CREATE_SCHEMA_SQL);
    this.sqlite.pragma(`user_version = ${EXPECTED_SCHEMA_VERSION}`);

    // SQLite ships no REGEXP implementation: the grammar accepts `X REGEXP Y`, which compiles to
    // regexp(Y, X), but with no such function defined the statement fails at prepare() time.
    // Supplying it here gives the matching rules real JS regex semantics — they use \b and negative
    // lookahead, neither of which Postgres's POSIX `~*` can express. Note the argument order: the
    // operator passes the PATTERN first.
    this.sqlite.function('regexp', (pattern: string, value: string) =>
      value != null && new RegExp(pattern, 'i').test(value) ? 1 : 0,
    );

    this.db = drizzle(this.sqlite, { schema });
    this.logger.info({ dbPath }, 'SQLite replica ready');
  }

  /** Raw better-sqlite3 handle — used to wrap bulk upserts in a single transaction. */
  get raw(): Database.Database {
    return this.sqlite;
  }

  onModuleDestroy() {
    this.sqlite?.close();
  }
}
