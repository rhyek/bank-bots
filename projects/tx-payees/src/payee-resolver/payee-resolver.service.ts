import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import PQueue from 'p-queue';
import { and, eq, sql } from 'drizzle-orm';
import { bankTx, category, matchingRule, payee } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import { TxMatcher } from '~/payee-resolver/tx-matcher.service';
import { MatchWriter } from '~/payee-resolver/match-writer.service';
import { TxAiResolver, isResolved, type MatchOutcome } from '~/payee-resolver/match-outcome';
import { hasNoneVerdict, lastLocation, selectBacklog } from '~/payee-resolver/backlog';
import { AppEvents } from '~/events/app-events';
import { windowDates } from '~/location/location-day';
import { OwnerLocationService } from '~/owner-location/owner-location.service';
import { WINDOW_DAYS, sameTxLocation, type TxLocation } from '~/owner-location/tx-location';
import { PayeeLocationService } from '~/payee-location/payee-location.service';

// Only transactions on or after this date are matched or located. Deliberately the TRANSACTION
// date, not created_at: 3145 rows share a single created_at from the YNAB history ingest while
// spanning transaction dates back to 2022, so a created_at cutoff would sweep in four years of
// history.
const FROM_DATE = '2026-01-01';

// How often the sweep repeats while the service stays up. The boot sweep alone is not enough for a
// process that runs for weeks: a freshly scraped transaction is located from days that are still
// provisional, and only a later sweep can make that lookup final.
const RESWEEP_MS = 24 * 60 * 60 * 1000;

/** What process() needs of a transaction. */
interface TxRow {
  id: string;
  date: string;
  description: string;
  payeeId: string | null;
  transferBankAccountId: string | null;
  reconcile: boolean;
  country: string | null;
  location: string | null;
}

// Gives every bank_tx row since FROM_DATE a payee + category, and a location: where the owner was
// when it was bought. Per transaction, in this order:
//
//   1. make sure the days of its ten-day window are resolved   (owner-location; may run an agent)
//   2. match a payee: exact, rule, then the AI tier            (skipped when it already has one)
//   3. look up its location among those days, and record it     (no agent)
//   4. if its payee's own place is unknown, look that up        (payee-location; runs an agent)
//      and, once it is known, redo step 3 for that payee's transactions
//
// Steps 1, 3 and 4 are the location steps. They are switched off together by
// TX_LOCATION_ENABLED=false, and none of them may fail step 2: each is guarded on its own.
//
// Work arrives entirely through AppEvents, so this module has no reference to replica-sync:
//   - 'replica-sync.startup-sync-finished' triggers the backlog sweep
//   - 'replica-sync.row-persisted'          queues a freshly scraped transaction (inserts only)
// Both funnel into enqueue(). Concurrency is 1, so jobs run strictly in order.
@Injectable()
export class PayeeResolver implements OnModuleInit, OnModuleDestroy {
  readonly queue = new PQueue({ concurrency: 1 });
  private readonly pending = new Set<string>();
  private readonly unsubscribes: (() => void)[] = [];
  private started = false;
  private resweep: NodeJS.Timeout | undefined;
  private skipped = 0;
  private skipReason = '';
  private located = 0;
  /**
   * Payees whose place was asked about since the queue last drained. A lookup that fails leaves
   * `location_kind` NULL, and without this every other transaction of that payee — dozens, for a
   * supermarket — would run the same failing agent call again in the same sweep.
   */
  private readonly payeesAsked = new Set<string>();

  constructor(
    private readonly replica: ReplicaDb,
    private readonly matcher: TxMatcher,
    private readonly writer: MatchWriter,
    private readonly ai: TxAiResolver,
    private readonly events: AppEvents,
    private readonly ownerLocation: OwnerLocationService,
    private readonly payeeLocation: PayeeLocationService,
    private readonly logger: StructuredLoggerService,
  ) {}

  // onModuleInit, not onApplicationBootstrap: Nest runs every onModuleInit hook before any
  // onApplicationBootstrap hook, and ReplicaSync kicks off its sync from the latter. Subscribing
  // here therefore guarantees the listener exists before the first event can be emitted, instead of
  // relying on ReplicaSync's initial `await` happening to yield first.
  onModuleInit() {
    // Order matters: report what this batch did and skipped, then hand the next batch a fresh
    // budget and a clean slate of failures to retry.
    this.queue.on('idle', () => {
      this.reportSkips();
      this.reportLocated();
      this.ai.resetBudget();
      this.payeesAsked.clear();
      this.ownerLocation.resetFailures();
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
    clearInterval(this.resweep);
    for (const off of this.unsubscribes) {
      off();
    }
    this.unsubscribes.length = 0;
  }

  /**
   * One line per decision, the same shape for every tier, with the agent's reasoning as `summary`
   * when there is any.
   *
   * Names beside the ids: a payee uuid tells someone watching the live log nothing. Whether a payee
   * was *created* or merely resolved matters even more — a new payee affects every future
   * transaction that matches it, so it should be visible as it happens rather than discovered later
   * in matcher_result.
   */
  private logOutcome(tx: TxRow, outcome: MatchOutcome) {
    if (outcome.type === 'skipped') {
      return;
    }
    const about = { txId: tx.id, description: tx.description, type: outcome.type };
    if (outcome.type === 'none') {
      this.logger.info({ ...about, summary: outcome.data?.summary || undefined }, 'payee decision');
      return;
    }

    const created = outcome.type === 'ai' ? outcome.data.created : undefined;
    const updated = outcome.type === 'ai' ? outcome.data.updated : undefined;

    this.logger.info(
      {
        ...about,
        payeeId: outcome.payeeId,
        payeeName: this.nameOf(payee, outcome.payeeId),
        payeeCreated: created?.payeeId === outcome.payeeId,
        categoryId: outcome.categoryId,
        categoryName: this.nameOf(category, outcome.categoryId),
        categoryCreated: created?.categoryId === outcome.categoryId,
        ruleCreated: created?.matchingRuleId ? this.labelOf(created.matchingRuleId) : undefined,
        ruleUpdated: updated?.matchingRuleId ? this.labelOf(updated.matchingRuleId) : undefined,
        summary: (outcome.type === 'ai' && outcome.data.summary) || undefined,
      },
      'payee decision',
    );
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
      { skipped: this.skipped, reason: this.skipReason },
      'transactions skipped without being examined; they remain unmapped and will be retried',
    );
    this.skipped = 0;
    this.skipReason = '';
  }

  /** Location lookups are silent per row, like skips, and reported once the queue drains. */
  private reportLocated() {
    if (this.located === 0) {
      return;
    }
    this.logger.info({ located: this.located }, 'located transactions');
    this.located = 0;
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
   * Begin sweeping: once now, then daily. Runs on 'replica-sync.startup-sync-finished' — matching
   * against a half-populated replica would copy from incomplete history.
   * Idempotent: a second call is a no-op.
   */
  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.sweep();
    this.resweep = setInterval(() => this.sweep(), RESWEEP_MS);
    this.resweep.unref();
  }

  /**
   * Queue every transaction since FROM_DATE that still has work: no payee, no final location, or a
   * payee whose own place has not been looked up. See selectBacklog for the exact conditions.
   *
   * Safe to repeat. A transaction that is still queued is not queued twice, and one with nothing
   * left to do is no longer selected.
   */
  sweep() {
    const withLocation = this.ownerLocation.enabled;
    const rows = selectBacklog(this.replica, FROM_DATE, withLocation);
    const unmapped = rows.filter((r) => r.payeeId === null).length;
    // Whatever is not `withoutPayee` was selected for a location step.
    this.logger.info(
      { transactions: rows.length, since: FROM_DATE, withoutPayee: unmapped, withLocation },
      'backlog',
    );
    if (rows.length === 0) {
      return;
    }
    if (withLocation) {
      // Resolve every day the batch will need in one pass, before any transaction. Left to the
      // transactions themselves, days would be asked for ten at a time in created_at order — which
      // is not date order — and the resolver would get fragments instead of 14-day runs. The city
      // fields of the batch's descriptions go the same way: one call for all of them.
      const dates = rows.flatMap((r) => windowDates(r.date, WINDOW_DAYS));
      const descriptions = rows.map((r) => r.description);
      void this.queue.add(async () => {
        await this.ownerLocation.ensureDays(dates);
        await this.ownerLocation.ensurePlaces(descriptions);
      });
    }
    for (const r of rows) {
      this.enqueue(r.id);
    }
  }

  /** Queue a transaction. Safe to call repeatedly — duplicates are ignored. */
  enqueue(txId: string) {
    if (this.pending.has(txId)) {
      return;
    }
    this.pending.add(txId);
    void this.queue.add(() => this.process(txId));
  }

  private readTx(txId: string): TxRow | undefined {
    return this.replica.db
      .select({
        id: bankTx.id,
        date: bankTx.date,
        description: bankTx.description,
        payeeId: bankTx.payeeId,
        transferBankAccountId: bankTx.transferBankAccountId,
        reconcile: bankTx.reconcile,
        country: bankTx.country,
        location: bankTx.location,
      })
      .from(bankTx)
      .where(eq(bankTx.id, txId))
      .get();
  }

  private async process(txId: string) {
    try {
      // Re-read rather than trusting the enqueue-time state: the row may have been mapped, changed,
      // or deleted between being queued and being run.
      const tx = this.readTx(txId);
      if (!tx) {
        return;
      }
      if (tx.transferBankAccountId != null || tx.reconcile || tx.date < FROM_DATE) {
        return;
      }
      const withLocation = this.ownerLocation.enabled;

      // 1. Before matching, because the AI tier is told where the owner was. Never throws.
      if (withLocation) {
        await this.ownerLocation.ensureDays(windowDates(tx.date, WINDOW_DAYS));
        await this.ownerLocation.ensurePlaces([tx.description]);
      }

      // 2. A 'none' verdict is terminal, and since the sweep now also selects for location it has
      //    to be honored here: a transaction the AI tier gave up on is still located, not re-asked.
      let payeeId = tx.payeeId;
      if (payeeId == null && !hasNoneVerdict(this.replica, txId)) {
        payeeId = await this.matchPayee(tx);
      }

      // 3 + 4.
      if (withLocation) {
        await this.locate(tx, payeeId);
      }
    } catch (err) {
      // One bad row must not stall the backlog, so failures are logged and dropped; the transaction
      // keeps whatever it is missing and is retried on the next sweep.
      this.logger.error({ error: err as Error, txId }, 'could not process transaction');
    } finally {
      this.pending.delete(txId);
    }
  }

  /** Step 2. Resolves to the payee the transaction now has, or null when it still has none. */
  private async matchPayee(tx: TxRow): Promise<string | null> {
    try {
      const outcome = await this.matcher.match({ id: tx.id, description: tx.description });

      // Never examined (tier off, no token, budget spent). Leave no trace: recording it would make
      // the transaction look permanently unanswerable. Debug level because it is expected and
      // applies to the whole backlog at once — one line per row would bury everything else.
      if (outcome.type === 'skipped') {
        this.skipped += 1;
        this.skipReason = outcome.reason;
        this.logger.debug(
          { txId: tx.id, description: tx.description, reason: outcome.reason },
          'skipped',
        );
        return null;
      }

      if (isResolved(outcome)) {
        await this.writer.applyMatch(tx.id, outcome.payeeId, outcome.categoryId);
      }
      this.logOutcome(tx, outcome);

      // Recorded for every tier that actually ran, including 'none'. A 'none' row is the terminal
      // marker that stops this transaction being re-asked on every sweep; see selectBacklog.
      await this.writer.recordResult(tx.id, outcome);
      return isResolved(outcome) ? outcome.payeeId : null;
    } catch (err) {
      // The transaction stays unmapped and is retried on the next sweep. It is still located.
      this.logger.error({ error: err as Error, txId: tx.id }, 'could not match transaction');
      return null;
    }
  }

  private readPayee(payeeId: string) {
    return this.replica.db
      .select({
        id: payee.id,
        name: payee.name,
        locationKind: payee.locationKind,
        country: payee.country,
      })
      .from(payee)
      .where(eq(payee.id, payeeId))
      .get();
  }

  /**
   * Steps 3 and 4. A failure here is logged and nothing more: whatever was not written stays
   * unwritten, nothing terminal is recorded, and the next sweep picks the transaction up again.
   */
  private async locate(tx: TxRow, payeeId: string | null) {
    try {
      const txPayee = payeeId ? this.readPayee(payeeId) : undefined;
      const location = await this.lookUp(tx, txPayee ?? null);

      if (!txPayee || txPayee.locationKind !== null || this.payeesAsked.has(txPayee.id)) {
        return;
      }
      this.payeesAsked.add(txPayee.id);
      const answer = await this.payeeLocation.resolve(txPayee.id, {
        txId: tx.id,
        date: tx.date,
        description: tx.description,
        ownerCountry: location.country,
        ownerLocation: location.location,
      });

      // Step 3 ran before the payee's place was known, so it could not use it. A physical business
      // changes the answer for any purchase made around a trip — a shop abroad whose charge posted
      // after the owner flew home — so the payee's transactions are looked up again, this one
      // included. Whatever the kind: a payee that was re-asked may have stopped being a physical
      // business, and its transactions then have to move back. A lookup that changes nothing
      // writes nothing.
      if (answer) {
        await this.relocatePayee(txPayee.id);
      }
    } catch (err) {
      this.logger.warn({ error: err as Error, txId: tx.id }, 'could not locate transaction');
    }
  }

  /**
   * Look a transaction's location up and write it when the lookup says something new: a different
   * place, or the same place now final.
   */
  private async lookUp(
    tx: TxRow,
    txPayee: { locationKind: string | null; country: string | null } | null,
  ): Promise<TxLocation> {
    const location = await this.ownerLocation.locate(tx, txPayee);
    const last = lastLocation(this.replica, tx.id);
    if (last && sameTxLocation(last, location)) {
      return location;
    }
    await this.writer.applyLocation(
      tx.id,
      location,
      tx.country !== location.country || tx.location !== location.location,
    );
    // Counted, not logged: a backfill looks up every transaction of the year, and a line each
    // would bury the payee decisions. reportLocated() gives the total when the queue drains.
    this.located += 1;
    return location;
  }

  private async relocatePayee(payeeId: string) {
    const txPayee = this.readPayee(payeeId);
    if (!txPayee) {
      return;
    }
    const ids = this.replica.db
      .select({ id: bankTx.id })
      .from(bankTx)
      .where(
        and(
          eq(bankTx.payeeId, payeeId),
          eq(bankTx.reconcile, false),
          sql`${bankTx.date} >= ${FROM_DATE}`,
        ),
      )
      .all();
    for (const { id } of ids) {
      const tx = this.readTx(id);
      if (tx && tx.transferBankAccountId == null) {
        await this.lookUp(tx, txPayee);
      }
    }
  }
}
