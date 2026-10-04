import fs from 'node:fs';
import path from 'node:path';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import Database from 'better-sqlite3';
import { DawarichClient } from '~/location/dawarich.client';
import { isSettled, summarizeDay, type LocationDay } from '~/location/location-day';

/** How long an unsettled day (recent, or empty) is trusted before it is asked for again. */
const RECHECK_MS = 12 * 60 * 60 * 1000;
/** After a failure, how long to leave Dawarich alone rather than time out on every request. */
const BACKOFF_MS = 5 * 60 * 1000;
const UTC_OFFSET_MS = -6 * 60 * 60 * 1000;
/** Bump when LocationDay changes shape. */
const CACHE_VERSION = 2;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS location_day (
  date TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
-- Left behind by the version that also cached a "last known position" lookup.
DROP TABLE IF EXISTS location_last_known;
`;

/**
 * What the owner's location tracker recorded on given days.
 *
 * One Dawarich request per calendar day, cached per day in its own SQLite file — separate from the
 * replica, which is a mirror of Postgres and gets dropped and rebuilt on a schema change.
 *
 * This is raw tracker data and it is not to be trusted on its own (see LocationDay.assumed). The
 * owner-location module weighs it against card charges; nothing else should read it.
 */
@Injectable()
export class LocationService implements OnModuleInit, OnModuleDestroy {
  private sqlite!: Database.Database;
  private unavailableUntil = 0;

  /** Overridable clock, for tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly client: DawarichClient,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit() {
    const dbPath =
      process.env.LOCATION_CACHE_DB_PATH ??
      path.join(process.cwd(), 'storage', 'location-cache.sqlite');
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.sqlite = new Database(dbPath);
    // A cached day is a summary in the shape of its day; when that shape changes, old rows are
    // refetched rather than read with fields missing.
    if (this.sqlite.pragma('user_version', { simple: true }) !== CACHE_VERSION) {
      this.sqlite.exec('DROP TABLE IF EXISTS location_day;');
    }
    this.sqlite.exec(CREATE_SQL);
    this.sqlite.pragma(`user_version = ${CACHE_VERSION}`);

    if (!process.env.DAWARICH_API_KEY) {
      this.logger.warn(
        'DAWARICH_API_KEY is not set — days will be resolved from card charges alone',
      );
    }
  }

  onModuleDestroy() {
    this.sqlite?.close();
  }

  /** Today's date where the owner is (UTC-6), which is what "more than two days old" is against. */
  today(): string {
    return new Date(this.now().getTime() + UTC_OFFSET_MS).toISOString().slice(0, 10);
  }

  /**
   * The tracker's summary of each date, in the order given — or `null` when the history cannot be
   * read at all (no API key, or Dawarich failing).
   *
   * All or nothing on purpose: the caller has to know whether it is looking at "the tracker recorded
   * nothing that day" or "the tracker could not be asked", and a partial answer would blur the two.
   * A failure is not cached, and Dawarich is then left alone for a few minutes.
   */
  async days(dates: string[]): Promise<LocationDay[] | null> {
    if (!process.env.DAWARICH_API_KEY || this.now().getTime() < this.unavailableUntil) {
      return null;
    }
    try {
      const days: LocationDay[] = [];
      for (const date of dates) {
        days.push(await this.day(date));
      }
      return days;
    } catch (error) {
      this.unavailableUntil = this.now().getTime() + BACKOFF_MS;
      this.logger.warn(
        { error: error as Error, backoffMinutes: BACKOFF_MS / 60_000 },
        'location history unavailable; going without it for now',
      );
      return null;
    }
  }

  private async day(date: string): Promise<LocationDay> {
    const row = this.sqlite
      .prepare('SELECT summary, fetched_at FROM location_day WHERE date = ?')
      .get(date) as { summary: string; fetched_at: number } | undefined;
    if (row) {
      const cached = JSON.parse(row.summary) as LocationDay;
      if (isSettled(cached, this.today()) || this.isRecent(row.fetched_at)) {
        return cached;
      }
    }
    const fresh = summarizeDay(date, await this.client.pointsForDay(date));
    this.sqlite
      .prepare(
        `INSERT INTO location_day (date, summary, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT (date) DO UPDATE SET summary = excluded.summary, fetched_at = excluded.fetched_at`,
      )
      .run(date, JSON.stringify(fresh), this.now().getTime());
    return fresh;
  }

  private isRecent(fetchedAt: number): boolean {
    return this.now().getTime() - fetchedAt < RECHECK_MS;
  }
}
