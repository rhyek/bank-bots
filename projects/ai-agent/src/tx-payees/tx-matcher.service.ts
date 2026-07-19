import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { bankTx, matchingRule } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';

export interface MatchableTx {
  id: string;
  description: string;
}

export interface MatchResult {
  payeeId: string;
  categoryId: string;
  /** How it was found: `exact`, or `regex:<rule label>`. Logged, not persisted. */
  via: string;
}

// Resolves a payee + category for an unmapped transaction from already-mapped history, in two tiers:
// exact description first, then merchant regex rules in priority order.
//
// A rule only selects WHICH history row to copy from — the answer always comes from history, never
// from the rule itself. (A rule carrying a fixed payee is the `forcePayee` behavior that was
// deliberately removed from the backfill script: it pins an answer and so propagates whatever
// mis-categorization happens to be most recent.) Both tiers exclude the transaction being matched,
// so a row can never source from itself.
@Injectable()
export class TxMatcher {
  private readonly logger = new Logger(TxMatcher.name);

  constructor(private readonly replica: ReplicaDb) {}

  match(tx: MatchableTx): MatchResult | null {
    const exact = this.mostRecentMapped(
      ne(bankTx.id, tx.id),
      eq(bankTx.description, tx.description),
    );
    if (exact) return { ...exact, via: 'exact' };

    for (const rule of this.rules()) {
      if (!this.patternMatches(rule.pattern, rule.label, tx.description)) continue;
      const src = this.mostRecentMapped(
        ne(bankTx.id, tx.id),
        sql`${bankTx.description} REGEXP ${rule.pattern}`,
      );
      if (src) return { ...src, via: `regex:${rule.label}` };
    }
    return null;
  }

  /** Enabled rules, lowest priority number first — first match wins. */
  private rules() {
    return this.replica.db
      .select({ label: matchingRule.label, pattern: matchingRule.pattern })
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
      this.logger.warn(`skipping rule '${label}': invalid pattern (${(err as Error).message})`);
      return false;
    }
  }

  // Most recent fully-mapped transaction satisfying the given predicates. `date DESC, id DESC`
  // matches the backfill script's ordering; uuidv7 ids sort lexicographically by creation time, so
  // the id tiebreaker still means "most recently created".
  private mostRecentMapped(...conditions: SQL[]): { payeeId: string; categoryId: string } | null {
    const row = this.replica.db
      .select({ payeeId: bankTx.payeeId, categoryId: bankTx.categoryId })
      .from(bankTx)
      .where(and(isNotNull(bankTx.payeeId), isNotNull(bankTx.categoryId), ...conditions))
      .orderBy(sql`${bankTx.date} DESC`, sql`${bankTx.id} DESC`)
      .limit(1)
      .get();
    return row?.payeeId != null && row.categoryId != null
      ? { payeeId: row.payeeId, categoryId: row.categoryId }
      : null;
  }
}
