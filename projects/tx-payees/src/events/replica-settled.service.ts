import { Injectable } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { AppEvents } from '~/events/app-events';
import { ReplicaDb } from '~/replica-db/replica-db.service';

/** How often the safety-net poll asks the replica directly. A keyed SELECT 1 is microseconds. */
const POLL_MS = 100;

/** Whitelist for the poll's table interpolation. */
const REPLICATED_TABLES = new Set([
  'payee',
  'category_group',
  'category',
  'bank_tx',
  'matching_rule',
  'matcher_result',
]);

/**
 * Generous on purpose.
 *
 * A NOTIFY round trip is ~70ms measured idle, which made 2s look like enormous headroom. It isn't:
 * under real queue load the same round trip takes ~1s even with the AI tier off, and during an agent
 * run it routinely exceeds 2s — so a 2s budget timed out on essentially every write, silently
 * dropping the feedback loop it exists to guarantee.
 *
 * Waiting longer costs little. The barrier only ever delays the *next* transaction, and an agent run
 * ahead of it already takes 20–60s, so 15s is well inside the noise. Timing out early costs much
 * more: a duplicate payee for every repeated description.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A write barrier between Postgres and the local replica.
 *
 * payee-resolver runs its queue at concurrency 1 for a reason: each resolved transaction becomes
 * history the next one can copy from. But matches are written to Postgres while the matching tiers
 * read SQLite, and the two are joined only by trg_replica_notify -> replica-sync. The next job's
 * exact-tier SELECT runs microseconds after the Postgres write returns, long before the notification
 * lands, so without a barrier it cannot see its predecessor's result.
 *
 * For the exact and regex tiers that was harmless — they copy from a source row already in the
 * replica, so nothing new is needed. The AI tier breaks it: it creates payees, categories and rules
 * that exist nowhere else yet. Left unbarriered, two transactions with the same description both
 * miss, both run the agent, and both create their own payee.
 *
 * Waiting here rather than writing through to SQLite ourselves keeps replica-sync the single writer
 * to the replica, and avoids duplicating its Descriptor/excludedSet row mapping in a second module
 * where it would silently drift.
 */
@Injectable()
export class ReplicaSettled {
  constructor(
    private readonly events: AppEvents,
    private readonly replica: ReplicaDb,
    private readonly logger: StructuredLoggerService,
  ) {}

  private get timeoutMs(): number {
    return Number(process.env.TX_AI_SETTLE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  }

  /**
   * Run `write`, then wait until replica-sync confirms the row reached SQLite.
   *
   * The listener is registered BEFORE `write` runs. That ordering is the whole point of taking the
   * write as a callback: register afterwards and a fast notification lands in the gap, the listener
   * never fires, and every write pays the full timeout. Passing the write in makes the ordering
   * impossible to invert at a call site.
   *
   * On timeout it warns and continues rather than throwing. The Postgres write has already
   * succeeded — that is the source of truth — so a missed confirmation costs at worst one redundant
   * agent call, and the next sweep self-corrects. A barrier must never fail the work it guards.
   */
  async around<T>(table: string, id: string, write: () => Promise<T>): Promise<T> {
    let landed!: () => void;
    const persisted = new Promise<void>((resolve) => {
      landed = resolve;
    });
    const off = this.events.on('replica-sync.row-persisted', ({ data }) => {
      if (data.table === table && data.id === id) {
        if (process.env.TX_DEBUG_BARRIER) {
          this.logger.info({ table, id }, 'barrier released by event');
        }
        landed();
      }
    });

    const started = Date.now();
    // Promise.race settles on the first winner but does NOT cancel the losers. Without explicit
    // teardown the timeout keeps running and logs a failure warning about a barrier that succeeded
    // seconds earlier — which is exactly the false alarm this class spent a while being blamed for.
    let poll: NodeJS.Timeout | undefined;
    let expire: NodeJS.Timeout | undefined;

    try {
      const result = await write();
      await Promise.race([
        persisted,
        new Promise<void>((resolve) => {
          poll = setInterval(() => {
            if (this.isPresent(table, id)) {
              resolve();
            }
          }, POLL_MS);
          poll.unref();
        }),
        new Promise<void>((resolve) => {
          expire = setTimeout(() => {
            this.reportTimeout(table, id);
            resolve();
          }, this.timeoutMs);
          expire.unref();
        }),
      ]);
      if (process.env.TX_DEBUG_BARRIER) {
        this.logger.info({ table, id, elapsedMs: Date.now() - started }, 'barrier settled');
      }
      return result;
    } finally {
      off();
      clearInterval(poll);
      clearTimeout(expire);
    }
  }

  private reportTimeout(table: string, id: string) {
    // Distinguish the two failures that otherwise look identical. If the row IS present, the
    // barrier's purpose was met and only the notification went missing. If it is absent,
    // replication itself is behind and the next transaction may not see this write.
    const inReplica = this.isPresent(table, id);
    this.logger.warn(
      { table, id, timeoutMs: this.timeoutMs, inReplica },
      inReplica
        ? 'replication landed but no confirmation arrived in time (event missed; the local copy is correct)'
        : 'row NOT in the replica after the timeout — replication is behind; the next transaction may not see this write',
    );
  }

  /** Table names come from our own call sites, never from user input or the agent. */
  private isPresent(table: string, id: string): boolean {
    if (!REPLICATED_TABLES.has(table)) {
      throw new Error(`refusing to poll unknown table '${table}'`);
    }
    try {
      return (
        this.replica.raw.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(id) !==
        undefined
      );
    } catch {
      // A rebuild in progress, or the table not yet created — treat as "not there yet".
      return false;
    }
  }
}
