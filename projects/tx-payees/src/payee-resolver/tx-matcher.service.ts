import { Injectable } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { and, eq, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { bankTx, matchingRule } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import { TxAiResolver, type MatchOutcome, type MatchableTx } from '~/payee-resolver/match-outcome';

export type { MatchableTx, MatchOutcome } from '~/payee-resolver/match-outcome';

// Resolves a payee + category for an unmapped transaction, in three tiers:
//   1. exact description match against already-mapped history
//   2. merchant regex rules, in priority order
//   3. the AI tier, as a last resort
//
// Tiers 1 and 2 only select WHICH history row to copy from — the answer always comes from history,
// never from the rule itself. (A rule carrying a fixed payee is the `forcePayee` behavior that was
// deliberately removed from the backfill script: it pins an answer and so propagates whatever
// mis-categorization happens to be most recent.) Both exclude the transaction being matched, so a
// row can never source from itself.
//
// Tier 3 is different in kind: it may introduce payees, categories and rules that do not exist yet.
// That is why its writes go through a replica barrier — see ReplicaSettled.
@Injectable()
export class TxMatcher {
  constructor(
    private readonly replica: ReplicaDb,
    private readonly ai: TxAiResolver,
    private readonly logger: StructuredLoggerService,
  ) {}

  async match(tx: MatchableTx): Promise<MatchOutcome> {
    const exact = this.mostRecentMapped(
      ne(bankTx.id, tx.id),
      eq(bankTx.description, tx.description),
    );
    if (exact) {
      return { type: 'exact', ...exact };
    }

    for (const rule of this.rules()) {
      if (!this.patternMatches(rule.pattern, rule.label, tx.description)) {
        continue;
      }
      const src = this.mostRecentMapped(
        ne(bankTx.id, tx.id),
        sql`${bankTx.description} REGEXP ${rule.pattern}`,
      );
      if (src) {
        return { type: 'rule', ...src, ruleId: rule.id, ruleLabel: rule.label };
      }
    }

    return this.ai.resolve(tx);
  }

  /** Enabled rules, lowest priority number first — first match wins. */
  private rules() {
    return this.replica.db
      .select({ id: matchingRule.id, label: matchingRule.label, pattern: matchingRule.pattern })
      .from(matchingRule)
      .where(eq(matchingRule.enabled, true))
      .orderBy(matchingRule.priority)
      .all();
  }

  // Tested in JS before touching SQL so a malformed pattern is skipped with a warning rather than
  // throwing out of the SQLite regexp() callback and failing the whole match.
  private patternMatches(pattern: string, label: string, description: string): boolean {
    try {
      return new RegExp(pattern, 'i').test(description);
    } catch (err) {
      this.logger.warn(
        { error: err as Error, rule: label, pattern },
        'skipping rule: invalid pattern',
      );
      return false;
    }
  }

  // Most recent fully-mapped transaction satisfying the given predicates. `date DESC, id DESC`
  // matches the backfill script's ordering; uuidv7 ids sort lexicographically by creation time, so
  // the id tiebreaker still means "most recently created". The row's own id comes back as
  // sourceTxId so the audit log can record exactly which transaction the answer was copied from.
  private mostRecentMapped(
    ...conditions: SQL[]
  ): { payeeId: string; categoryId: string; sourceTxId: string } | null {
    const row = this.replica.db
      .select({ id: bankTx.id, payeeId: bankTx.payeeId, categoryId: bankTx.categoryId })
      .from(bankTx)
      .where(and(isNotNull(bankTx.payeeId), isNotNull(bankTx.categoryId), ...conditions))
      .orderBy(sql`${bankTx.date} DESC`, sql`${bankTx.id} DESC`)
      .limit(1)
      .get();
    return row?.payeeId != null && row.categoryId != null
      ? { payeeId: row.payeeId, categoryId: row.categoryId, sourceTxId: row.id }
      : null;
  }
}
