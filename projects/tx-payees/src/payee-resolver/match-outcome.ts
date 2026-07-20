/** The transaction being matched. Only what every tier needs to decide. */
export interface MatchableTx {
  id: string;
  description: string;
}

/** What the AI tier created or changed while reaching its answer, plus its own account of why. */
export interface MatcherData {
  summary: string;
  confidence?: 'high' | 'medium' | 'low';
  /** Recorded by the write tools as they fire — not self-reported by the model. */
  created?: {
    payeeId?: string | null;
    categoryId?: string | null;
    matchingRuleId?: string | null;
  };
  updated?: {
    matchingRuleId?: string | null;
  };
}

/**
 * The result of a match attempt. Always an object, never a bare null: a 'none' verdict carries the
 * reasoning behind it, which is what makes it worth persisting and what lets the backlog sweep stop
 * re-asking an unanswerable question on every boot.
 */
export type MatchOutcome =
  | { type: 'exact'; payeeId: string; categoryId: string; sourceTxId: string }
  | {
      type: 'rule';
      payeeId: string;
      categoryId: string;
      sourceTxId: string;
      ruleId: string;
      ruleLabel: string;
    }
  | { type: 'ai'; payeeId: string; categoryId: string; data: MatcherData }
  | { type: 'none'; data?: MatcherData }
  /**
   * No answer, and deliberately NOT recorded — the AI tier never ran (disabled, no token, or the
   * per-sweep budget is spent). Distinct from 'none', which means the tier *did* run and found
   * nothing and is therefore terminal. Recording a skip as 'none' would permanently exclude a
   * transaction that was never actually examined.
   */
  | { type: 'skipped'; reason: string };

/** Narrowing helper: did this attempt produce a payee + category to write? */
export function isResolved(
  outcome: MatchOutcome,
): outcome is Extract<MatchOutcome, { payeeId: string }> {
  return outcome.type !== 'none' && outcome.type !== 'skipped';
}

/**
 * The AI tier, as TxMatcher sees it.
 *
 * An abstract class rather than an interface so it doubles as a Nest injection token. Tiers 1 and 2
 * stay testable against an in-memory SQLite replica with no agent, no network and no API token by
 * substituting a stub that always answers 'none'.
 */
export abstract class TxAiResolver {
  abstract resolve(tx: MatchableTx): Promise<MatchOutcome>;

  /**
   * Start a fresh spend budget. Called when the work queue drains.
   *
   * The budget bounds a *batch* of work, not the process. Without a reset, a long-running service
   * that spent its budget on the boot backlog would skip every transaction the daily scrape brings
   * in afterwards — silently, and until someone restarted it.
   *
   * Concrete no-op so stubs and future tiers need not care.
   */
  resetBudget(): void {}
}
