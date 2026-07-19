import { Injectable, Logger } from '@nestjs/common';
import PQueue from 'p-queue';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { bankTx as pgBankTx, db as pgDb, eq as pgEq } from '@bank-bots/db';
import { bankTx } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import { TxMatcher } from '~/payee-resolver/tx-matcher.service';

// Only transactions on or after this date are matched. Deliberately the TRANSACTION date, not
// created_at: 3145 rows share a single created_at from the YNAB history ingest while spanning
// transaction dates back to 2022, so a created_at cutoff would sweep in four years of history.
const FROM_DATE = '2026-01-01';

// Matches unmapped bank_tx rows to a payee + category and writes the result to Postgres. Work
// arrives from two places, both through enqueue(): a backlog sweep when the replica first finishes
// syncing, and the replica's LISTEN/NOTIFY path as new transactions land.
//
// Concurrency is 1, so jobs run strictly in order. The queue is public because ReplicaSync pushes
// into it — see replica-sync.service.ts.
@Injectable()
export class PayeeResolver {
  private readonly logger = new Logger(PayeeResolver.name);
  readonly queue = new PQueue({ concurrency: 1 });
  private readonly pending = new Set<string>();
  private started = false;

  constructor(
    private readonly replica: ReplicaDb,
    private readonly matcher: TxMatcher,
  ) {}

  /**
   * Sweep the backlog of unmapped transactions. Called by ReplicaSync once the first delta sync has
   * completed — matching against a half-populated replica would copy from incomplete history.
   * Idempotent: a second call is a no-op.
   */
  start() {
    if (this.started) return;
    this.started = true;
    const rows = this.replica.db
      .select({ id: bankTx.id })
      .from(bankTx)
      .where(
        and(
          isNull(bankTx.payeeId),
          isNull(bankTx.transferBankAccountId),
          eq(bankTx.reconcile, false),
          sql`${bankTx.date} >= ${FROM_DATE}`,
        ),
      )
      // created_at ties are common (one per scrape run), so id breaks them for a stable order.
      .orderBy(asc(bankTx.createdAt), asc(bankTx.id))
      .all();
    this.logger.log(`backlog: ${rows.length} unmapped transactions since ${FROM_DATE}`);
    for (const r of rows) this.enqueue(r.id);
  }

  /** Queue a transaction for matching. Safe to call repeatedly — duplicates are ignored. */
  enqueue(txId: string) {
    if (this.pending.has(txId)) return;
    this.pending.add(txId);
    void this.queue.add(() => this.process(txId));
  }

  private async process(txId: string) {
    try {
      const tx = this.replica.db
        .select({
          id: bankTx.id,
          date: bankTx.date,
          description: bankTx.description,
          payeeId: bankTx.payeeId,
          transferBankAccountId: bankTx.transferBankAccountId,
          reconcile: bankTx.reconcile,
        })
        .from(bankTx)
        .where(eq(bankTx.id, txId))
        .get();
      // Re-read rather than trusting the enqueue-time state: the row may have been mapped, changed,
      // or deleted between being queued and being run.
      if (!tx) return;
      if (tx.payeeId != null || tx.transferBankAccountId != null || tx.reconcile) return;
      if (tx.date < FROM_DATE) return;

      const result = this.matcher.match({ id: tx.id, description: tx.description });
      if (!result) {
        this.logger.debug(`no match: "${tx.description}"`);
        return;
      }

      // Write to Postgres, the source of truth. Its trigger emits NOTIFY, which brings the values
      // back into SQLite; because payee_id is set by then, the row is not re-enqueued and this
      // cannot loop.
      await pgDb
        .update(pgBankTx)
        .set({ payeeId: result.payeeId, categoryId: result.categoryId })
        .where(pgEq(pgBankTx.id, txId));
      this.logger.log(`${result.via}: "${tx.description}" -> ${result.payeeId}`);
    } catch (err) {
      // One bad row must not stall the backlog, so failures are logged and dropped; the transaction
      // stays unmapped and is retried on the next boot.
      this.logger.error(`process ${txId}: ${(err as Error).message}`);
    } finally {
      this.pending.delete(txId);
    }
  }
}
