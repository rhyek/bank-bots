import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Client, type Notification } from 'pg';
import {
  bankTx as pgBankTx,
  category as pgCategory,
  payee as pgPayee,
  count as pgCount,
  db as pgDb,
  eq as pgEq,
  gt as pgGt,
} from '@bank-bots/db';
import { eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import {
  bankTx as liteBankTx,
  category as liteCategory,
  payee as litePayee,
} from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';

const CHANNEL = 'replica_events';
const MAX_RECONNECT_MS = 30_000;
const UPSERT_CHUNK = 200;

// A replicated table: its Postgres source (@bank-bots/db) + SQLite mirror. Every replicated id is
// text (bank_tx is a uuidv7; payee/category are the YNAB uuids), so the notify payload's id needs no
// casting before it's used as a key.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Descriptor = { name: string; pg: any; lite: any };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

@Injectable()
export class ReplicaSync implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReplicaSync.name);
  private client: Client | null = null;
  private shuttingDown = false;
  private syncing = false;
  private reconnectScheduled = false;
  private reconnectMs = 1_000;

  // Dependency order: payee + category before bank_tx (which references them).
  private readonly tables: Descriptor[] = [
    { name: 'payee', pg: pgPayee, lite: litePayee },
    { name: 'category', pg: pgCategory, lite: liteCategory },
    { name: 'bank_tx', pg: pgBankTx, lite: liteBankTx },
  ];
  private readonly byName = new Map(this.tables.map((t) => [t.name, t]));

  constructor(private readonly replica: ReplicaDb) {}

  // Kicked off in the background so a slow first-ever sync (the initial full pull can be large over a
  // slow link) never blocks the app from listening. The listener is connected first, then the delta
  // sync runs; either failing schedules a retry.
  onApplicationBootstrap() {
    void this.start();
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    await this.client?.end().catch(() => undefined);
  }

  private async start() {
    if (this.shuttingDown) return;
    try {
      await this.connectListener(); // LISTEN before syncing so events during the snapshot aren't lost
      await this.deltaSync();
    } catch (err) {
      this.scheduleReconnect(err as Error);
    }
  }

  // ---------- delta sync (boot + reconnect catch-up) ----------

  private async deltaSync() {
    if (this.syncing) return; // never overlap an initial sync with a reconnect-triggered one
    this.syncing = true;
    try {
      for (const t of this.tables) {
        const upserts = await this.syncUpserts(t);
        const deletes = await this.syncDeletes(t);
        this.logger.log(`sync ${t.name}: +${upserts} upserted, -${deletes} deleted`);
      }
    } finally {
      this.syncing = false;
    }
  }

  /** Pull rows changed since our watermark (minus a margin) and upsert them into SQLite. */
  private async syncUpserts(t: Descriptor): Promise<number> {
    // Watermark = the newest updated_at we already hold. Strict `>` so a quiet boot pulls nothing
    // (rows sharing the max — e.g. all of them right after the migration set them to the same now() —
    // are already stored). Real-time NOTIFY covers changes; the boot delta only catches offline ones.
    const watermark = this.replica.db
      .select({ m: sql<string | null>`max(${t.lite.updatedAt})` })
      .from(t.lite)
      .get()?.m;
    const rows = watermark
      ? await pgDb.select().from(t.pg).where(pgGt(t.pg.updatedAt, watermark))
      : await pgDb.select().from(t.pg);
    if (rows.length === 0) return 0;
    const set = this.excludedSet(t.lite);
    this.replica.raw.transaction(() => {
      for (const c of chunk(rows, UPSERT_CHUNK)) {
        this.replica.db
          .insert(t.lite)
          .values(c)
          .onConflictDoUpdate({ target: t.lite.id, set })
          .run();
      }
    })();
    return rows.length;
  }

  /**
   * Remove rows deleted in Postgres while offline. After upserts, SQLite is a superset of PG, so
   * equal row counts mean no deletions — skip the (relatively expensive) all-ids fetch. Only when the
   * counts differ do we pull PG's ids and delete the SQLite rows that are no longer present.
   */
  private async syncDeletes(t: Descriptor): Promise<number> {
    const pgCountVal = (await pgDb.select({ c: pgCount() }).from(t.pg))[0].c;
    const liteCountVal =
      this.replica.db
        .select({ c: sql<number>`count(*)` })
        .from(t.lite)
        .get()?.c ?? 0;
    if (pgCountVal === liteCountVal) return 0;

    const pgIds = new Set((await pgDb.select({ id: t.pg.id }).from(t.pg)).map((r) => r.id));
    const liteIds = this.replica.db
      .select({ id: t.lite.id })
      .from(t.lite)
      .all()
      .map((r) => r.id as string | number);
    const toDelete = liteIds.filter((id) => !pgIds.has(id));
    if (toDelete.length === 0) return 0;
    this.replica.raw.transaction(() => {
      for (const c of chunk(toDelete, UPSERT_CHUNK)) {
        this.replica.db.delete(t.lite).where(inArray(t.lite.id, c)).run();
      }
    })();
    return toDelete.length;
  }

  /** `SET col = excluded.col` for every column except the primary key. */
  private excludedSet(liteTable: Descriptor['lite']): Record<string, unknown> {
    const set: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(getTableColumns(liteTable))) {
      if (key === 'id') continue;
      set[key] = sql`excluded.${sql.identifier((col as { name: string }).name)}`;
    }
    return set;
  }

  // ---------- realtime (LISTEN/NOTIFY) ----------

  private async connectListener() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.on('notification', (msg) => void this.onNotification(msg));
    client.on('error', (err) => this.scheduleReconnect(err));
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.client = client;
    this.reconnectMs = 1_000;
    this.logger.log(`listening on '${CHANNEL}'`);
  }

  private scheduleReconnect(err: Error) {
    if (this.shuttingDown || this.reconnectScheduled) return; // one pending timer at a time
    this.reconnectScheduled = true;
    this.logger.warn(
      `replica listener down (${err.message}); reconnecting in ${this.reconnectMs}ms`,
    );
    void this.client?.end().catch(() => undefined);
    this.client = null;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
    setTimeout(() => void this.reconnect(), delay);
  }

  private async reconnect() {
    this.reconnectScheduled = false;
    if (this.shuttingDown) return;
    try {
      await this.connectListener();
      await this.deltaSync(); // close any gap from the disconnect window
    } catch (err) {
      this.scheduleReconnect(err as Error);
    }
  }

  private async onNotification(msg: Notification) {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    let evt: { table: string; op: string; id: string };
    try {
      evt = JSON.parse(msg.payload);
    } catch {
      this.logger.warn(`bad payload: ${msg.payload}`);
      return;
    }
    const t = this.byName.get(evt.table);
    if (!t) return;
    const id = evt.id;
    try {
      if (evt.op === 'delete') {
        this.replica.db.delete(t.lite).where(eq(t.lite.id, id)).run();
      } else {
        const [row] = await pgDb.select().from(t.pg).where(pgEq(t.pg.id, id));
        if (!row) return; // already gone; a delete event will follow
        this.replica.db
          .insert(t.lite)
          .values(row)
          .onConflictDoUpdate({ target: t.lite.id, set: this.excludedSet(t.lite) })
          .run();
      }
    } catch (err) {
      this.logger.error(`apply ${evt.op} ${evt.table}#${evt.id}: ${(err as Error).message}`);
    }
  }
}
