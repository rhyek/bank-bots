import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import PQueue from 'p-queue';
import { and, asc, eq, isNull, notExists, sql } from 'drizzle-orm';
import { bankTx, category, matcherResult, matchingRule, payee } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import { TxMatcher } from '~/payee-resolver/tx-matcher.service';
import { MatchWriter } from '~/payee-resolver/match-writer.service';
import { TxAiResolver, isResolved, type MatchOutcome } from '~/payee-resolver/match-outcome';
import { AppEvents } from '~/events/app-events';

// Only transactions on or after this date are matched. Deliberately the TRANSACTION date, not
// created_at: 3145 rows share a single created_at from the YNAB history ingest while spanning
// transaction dates back to 2022, so a created_at cutoff would sweep in four years of history.
const FROM_DATE = '2026-01-01';

// Matches unmapped bank_tx rows to a payee + category and writes the result to Postgres.
//
// Work arrives entirely through AppEvents, so this module has no reference to replica-sync:
//   - 'replica-sync.startup-sync-finished' triggers the backlog sweep
//   - 'replica-sync.row-persisted'          queues a freshly scraped transaction (inserts only)
// Both funnel into enqueue(). Concurrency is 1, so jobs run strictly in order.
@Injectable()
export class PayeeResolver implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayeeResolver.name);
  readonly queue = new PQueue({ concurrency: 1 });
  private readonly pending = new Set<string>();
  private readonly unsubscribes: (() => void)[] = [];
  private started = false;
  private skipped = 0;
  private skipReason = '';

  constructor(
    private readonly replica: ReplicaDb,
    private readonly matcher: TxMatcher,
    private readonly writer: MatchWriter,
    private readonly ai: TxAiResolver,
    private readonly events: AppEvents,
  ) {}

  // onModuleInit, not onApplicationBootstrap: Nest runs every onModuleInit hook before any
  // onApplicationBootstrap hook, and ReplicaSync kicks off its sync from the latter. Subscribing
  // here therefore guarantees the listener exists before the first event can be emitted, instead of
  // relying on ReplicaSync's initial `await` happening to yield first.
  onModuleInit() {
    // Order matters: report what this batch skipped, then hand the next batch a fresh budget.
    this.queue.on('idle', () => {
      this.reportSkips();
      this.ai.resetBudget();
    });
    this.unsubscribes.push(
      this.events.on('replica-sync.startup-sync-finished', () => {
        this.start();
      }),
      this.events.on('replica-sync.row-persisted', ({ data }) => {
        // Inserts only. A scraped transaction always arrives unmapped, so an insert means real
        // work. An *update* to a still-unmapped row (a re-scrape changing amount_cents, say)
        // deliberately does not re-queue it — the next startup sweep picks it up. Note this filter
        // is not what prevents a feedback loop from our own payee writes; the payeeId check in
        // onNewTx does that, and would hold even without this.
        if (data.table !== 'bank_tx' || data.op !== 'insert') {
          return;
        }
        this.onNewTx(data.id);
      }),
    );
  }

  onModuleDestroy() {
    for (const off of this.unsubscribes) {
      off();
    }
    this.unsubscribes.length = 0;
  }

  /**
   * One line per decision, the same shape for every tier, plus the agent's reasoning when there is
   * any.
   *
   * Names rather than ids: a payee uuid tells someone watching the live log nothing. Whether a payee
   * was *created* or merely resolved matters even more — a new payee affects every future
   * transaction that matches it, so it should be visible as it happens rather than discovered later
   * in matcher_result.
   */
  private logOutcome(description: string, outcome: MatchOutcome) {
    if (outcome.type === 'skipped') {
      return;
    }
    if (outcome.type === 'none') {
      this.logger.log(`none: "${description}"`);
      if (outcome.data?.summary) {
        this.logger.log(`  why: ${outcome.data.summary}`);
      }
      return;
    }

    const created = outcome.type === 'ai' ? outcome.data.created : undefined;
    const updated = outcome.type === 'ai' ? outcome.data.updated : undefined;
    const payeeName = this.nameOf(payee, outcome.payeeId);
    const categoryName = this.nameOf(category, outcome.categoryId);
    const payeeVerb = created?.payeeId === outcome.payeeId ? 'created' : 'resolved';

    const extras: string[] = [];
    if (created?.categoryId === outcome.categoryId) {
      extras.push('new category');
    }
    if (created?.matchingRuleId) {
      extras.push(`+rule "${this.labelOf(created.matchingRuleId)}"`);
    }
    if (updated?.matchingRuleId) {
      extras.push(`updated rule "${this.labelOf(updated.matchingRuleId)}"`);
    }
    const suffix = extras.length > 0 ? `  [${extras.join(', ')}]` : '';

    this.logger.log(
      `${outcome.type}: "${description}" -> ${payeeVerb} payee "${payeeName}" / ` +
        `category "${categoryName}"${suffix}`,
    );
    if (outcome.type === 'ai' && outcome.data.summary) {
      this.logger.log(`  why: ${outcome.data.summary}`);
    }
  }

  private nameOf(table: typeof payee | typeof category, id: string): string {
    return (
      this.replica.db.select({ name: table.name }).from(table).where(eq(table.id, id)).get()
        ?.name ?? id
    );
  }

  private labelOf(id: string): string {
    return (
      this.replica.db
        .select({ label: matchingRule.label })
        .from(matchingRule)
        .where(eq(matchingRule.id, id))
        .get()?.label ?? id
    );
  }

  /**
   * Report skips once the queue drains, rather than per row.
   *
   * Skips are silent per row by design — they arrive in bulk, the whole backlog at once, when the AI
   * tier is unavailable. Silent and *unreported* would be worse than noisy though: it would look
   * like the sweep succeeded when nothing was actually examined.
   */
  private reportSkips() {
    if (this.skipped === 0) {
      return;
    }
    this.logger.warn(
      `${this.skipped} transactions skipped without being examined (${this.skipReason}). ` +
        'They remain unmapped and will be retried.',
    );
    this.skipped = 0;
    this.skipReason = '';
  }

  // A scraped transaction should always arrive unmapped, but the emitter can't guarantee that for
  // rows inserted by other paths (the ingest scripts, a manual INSERT), so confirm before queueing.
  private onNewTx(txId: string) {
    const row = this.replica.db
      .select({ payeeId: bankTx.payeeId })
      .from(bankTx)
      .where(eq(bankTx.id, txId))
      .get();
    if (!row || row.payeeId != null) {
      return;
    }
    this.enqueue(txId);
  }

  /**
   * Sweep the backlog of unmapped transactions. Runs on 'replica-sync.startup-sync-finished' —
   * matching against a half-populated replica would copy from incomplete history.
   * Idempotent: a second call is a no-op.
   */
  start() {
    if (this.started) {
      return;
    }
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
          // A 'none' verdict is terminal: the AI tier already looked and found no answer. Roughly
          // one in eight unmapped rows is an inter-account transfer that can never have a payee,
          // and without this they would cost an agent call on every single boot. Re-ask by hand
          // with: DELETE FROM matcher_result WHERE bank_tx_id = '<uuid>' AND type = 'none';
          notExists(
            this.replica.db
              .select({ one: sql`1` })
              .from(matcherResult)
              .where(and(eq(matcherResult.bankTxId, bankTx.id), eq(matcherResult.type, 'none'))),
          ),
        ),
      )
      // created_at ties are common (one per scrape run), so id breaks them for a stable order.
      .orderBy(asc(bankTx.createdAt), asc(bankTx.id))
      .all();
    this.logger.log(`backlog: ${rows.length} unmapped transactions since ${FROM_DATE}`);
    for (const r of rows) {
      this.enqueue(r.id);
    }
  }

  /** Queue a transaction for matching. Safe to call repeatedly — duplicates are ignored. */
  enqueue(txId: string) {
    if (this.pending.has(txId)) {
      return;
    }
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
      if (!tx) {
        return;
      }
      if (tx.payeeId != null || tx.transferBankAccountId != null || tx.reconcile) {
        return;
      }
      if (tx.date < FROM_DATE) {
        return;
      }

      const outcome = await this.matcher.match({ id: tx.id, description: tx.description });

      // Never examined (tier off, no token, budget spent). Leave no trace: recording it would make
      // the transaction look permanently unanswerable. Debug level because it is expected and
      // applies to the whole backlog at once — one line per row would bury everything else.
      if (outcome.type === 'skipped') {
        this.skipped += 1;
        this.skipReason = outcome.reason;
        this.logger.debug(`skipped "${tx.description}": ${outcome.reason}`);
        return;
      }

      if (isResolved(outcome)) {
        await this.writer.applyMatch(txId, outcome.payeeId, outcome.categoryId);
      }
      this.logOutcome(tx.description, outcome);

      // Recorded for every tier that actually ran, including 'none'. A 'none' row is the terminal
      // marker that stops this transaction being re-asked on every boot; see start().
      await this.writer.recordResult(txId, outcome);
    } catch (err) {
      // One bad row must not stall the backlog, so failures are logged and dropped; the transaction
      // stays unmapped and is retried on the next boot.
      this.logger.error(`process ${txId}: ${(err as Error).message}`);
    } finally {
      this.pending.delete(txId);
    }
  }
}
