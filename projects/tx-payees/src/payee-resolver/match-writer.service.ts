import { Injectable } from '@nestjs/common';
import {
  bankTx as pgBankTx,
  matcherResult as pgMatcherResult,
  db as pgDb,
  eq as pgEq,
} from '@bank-bots/db';
import { v7 as uuidv7 } from 'uuid';
import { ReplicaSettled } from '~/events/replica-settled.service';
import type { MatchOutcome } from '~/payee-resolver/match-outcome';
import type { TxLocation } from '~/owner-location/tx-location';

/**
 * Every write payee-resolver makes, in one place.
 *
 * Extracted from PayeeResolver so the resolver can be tested without Postgres — and so the replica
 * barrier is applied in exactly one place rather than at each call site.
 */
@Injectable()
export class MatchWriter {
  constructor(private readonly settle: ReplicaSettled) {}

  /**
   * Write a resolved match to Postgres, the source of truth, and wait for it to reach the replica.
   *
   * The barrier matters here: the queue runs at concurrency 1 precisely so the next transaction can
   * copy from this one, and the next job's exact-tier SELECT reads SQLite microseconds from now.
   * Postgres's trigger notifies the replica, and because payee_id is set by the time the row comes
   * back, the row is not re-enqueued — this cannot loop.
   */
  async applyMatch(txId: string, payeeId: string, categoryId: string): Promise<void> {
    await this.settle.around('bank_tx', txId, async () => {
      await pgDb.update(pgBankTx).set({ payeeId, categoryId }).where(pgEq(pgBankTx.id, txId));
    });
  }

  /**
   * Append the attempt to the audit log.
   *
   * Deliberately NOT barriered. Nothing reads matcher_result during a sweep — the skip check runs
   * once at startup, by which time the boot delta sync has pulled every row anyway. Adding a second
   * barrier per job would buy nothing and would cost the full timeout on each one whenever the
   * listener is down.
   */
  async recordResult(
    txId: string,
    // 'skipped' is excluded at the type level: a tier that never ran must leave no verdict behind,
    // and a recorded 'none' would be terminal.
    outcome: Exclude<MatchOutcome, { type: 'skipped' }>,
  ): Promise<void> {
    await pgDb.insert(pgMatcherResult).values({
      id: uuidv7(),
      bankTxId: txId,
      type: outcome.type,
      payeeId: outcome.type === 'none' ? null : outcome.payeeId,
      categoryId: outcome.type === 'none' ? null : outcome.categoryId,
      sourceTxId: outcome.type === 'exact' || outcome.type === 'rule' ? outcome.sourceTxId : null,
      matchingRuleId: outcome.type === 'rule' ? outcome.ruleId : null,
      data: outcome.type === 'ai' || outcome.type === 'none' ? (outcome.data ?? null) : null,
    });
  }

  /**
   * Write where the owner was when a transaction was bought, and append the lookup to the audit
   * log as a `location` row.
   *
   * The two columns are only rewritten when they changed; the audit row is written either way,
   * because a lookup that reaches the same place for good (`final`) is news the sweep needs.
   *
   * Both writes are barriered, unlike recordResult. Later work in the same sweep reads them back
   * from the replica: the "did this lookup change anything" check compares against the last
   * `location` row, and a re-lookup can follow within the same job once the payee's own place is
   * known.
   */
  async applyLocation(txId: string, location: TxLocation, columnsChanged: boolean): Promise<void> {
    if (columnsChanged) {
      await this.settle.around('bank_tx', txId, async () => {
        await pgDb
          .update(pgBankTx)
          .set({ country: location.country, location: location.location })
          .where(pgEq(pgBankTx.id, txId));
      });
    }
    const id = uuidv7();
    await this.settle.around('matcher_result', id, async () => {
      await pgDb
        .insert(pgMatcherResult)
        .values({ id, bankTxId: txId, type: 'location', data: location });
    });
  }
}
