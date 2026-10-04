import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { bankTx, category, matchingRule, payee } from '~/replica-db/replica-schema';
import type { ReplicaDb } from '~/replica-db/replica-db.service';

/** How many descriptions a candidate pattern is timed against, and the budget it must fit in. */
const REDOS_SAMPLE = 200;
const REDOS_BUDGET_MS = 50;

/**
 * Nested unbounded quantifiers — `(a+)+`, `(a*)*`, `(a+)*` and friends.
 *
 * This has to be a STATIC check, not a timing one. A timing check measures how long the regex took
 * *after* running it, but catastrophic backtracking is exponential in the input length: `(a+)+$`
 * against a 34-character string is ~2^34 steps, so the process wedges long before there is an
 * elapsed time to measure. The timing check below is still worth keeping as a backstop for merely
 * slow patterns, but this is what actually prevents the hang.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[*+]|\([^)]*\{\d+,\}?[^)]*\)\s*[*+]/;

/** A pattern matching more than this share of mapped history is treated as a mis-write, not a rule. */
const MAX_MAPPED_SHARE = 0.3;

/**
 * Below this much mapped history the share test is meaningless and is skipped.
 *
 * On a small or freshly-rebuilt replica a perfectly good merchant rule can legitimately match a
 * large fraction of the few rows present — 4 Amazon rows out of 7 is 57%, which says nothing about
 * the rule. Enforcing the ratio there would reject every rule until history accumulated.
 */
const MIN_HISTORY_FOR_SHARE = 50;

export interface RegexReport {
  ok: boolean;
  reason?: string;
  /** Mapped transactions the pattern hits, and whether they agree on a payee. */
  mapped: { total: number; share: number; byPayee: { payee: string; count: number }[] };
  /** Currently-unmapped transactions the pattern would resolve. */
  unmappedWouldCatch: number;
  samples: string[];
  overlappingRules: { id: string; label: string; pattern: string }[];
}

/** Trailing 2-letter uppercase token, e.g. the "NL" in "UBER *TRIP  NL". */
function trailingCountry(description: string): string | null {
  const m = /\b([A-Z]{2})$/.exec(description.trimEnd());
  return m ? m[1] : null;
}

/**
 * Evaluate a candidate rule pattern against real history.
 *
 * This is what makes autonomous rule-writing defensible: the agent can see whether the transactions
 * a pattern hits actually agree on one payee before committing it, rather than guessing. It is also
 * the safety gate — an accepted pattern runs against every description on every future match, so a
 * catastrophically backtracking or matches-everything regex would break matching permanently rather
 * than merely be wrong once.
 */
export function testRegex(replica: ReplicaDb, pattern: string): RegexReport {
  const empty: RegexReport = {
    ok: false,
    mapped: { total: 0, share: 0, byPayee: [] },
    unmappedWouldCatch: 0,
    samples: [],
    overlappingRules: [],
  };

  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    return { ...empty, reason: `not a valid regex: ${(err as Error).message}` };
  }

  // Refuse the shape before running it at all — see NESTED_QUANTIFIER. Running first and timing
  // afterwards would hang here rather than report.
  if (NESTED_QUANTIFIER.test(pattern)) {
    return {
      ...empty,
      reason:
        'pattern nests an unbounded quantifier inside a quantified group (e.g. "(a+)+"), which ' +
        'backtracks exponentially — it would hang every future match. Rewrite it without the ' +
        'nesting, e.g. anchor on literal text with \\b word boundaries.',
    };
  }

  // Backstop for patterns that are merely slow rather than explosive. Descriptions cap at ~30
  // characters, so a non-nested pattern cannot blow up here.
  const sample = replica.db
    .select({ description: bankTx.description })
    .from(bankTx)
    .limit(REDOS_SAMPLE)
    .all();
  const started = performance.now();
  for (const row of sample) {
    re.test(row.description);
  }
  const elapsed = performance.now() - started;
  if (elapsed > REDOS_BUDGET_MS) {
    return {
      ...empty,
      reason:
        `pattern took ${elapsed.toFixed(0)}ms against ${sample.length} descriptions ` +
        `(budget ${REDOS_BUDGET_MS}ms) — it backtracks badly and would slow every future match`,
    };
  }

  const mappedRows = replica.db
    .select({ description: bankTx.description, payeeName: payee.name })
    .from(bankTx)
    .innerJoin(payee, eq(payee.id, bankTx.payeeId))
    .where(and(isNotNull(bankTx.payeeId), isNotNull(bankTx.categoryId)))
    .all();
  const hits = mappedRows.filter((r) => re.test(r.description));

  const byPayee = new Map<string, number>();
  for (const h of hits) {
    byPayee.set(h.payeeName, (byPayee.get(h.payeeName) ?? 0) + 1);
  }

  const share = mappedRows.length === 0 ? 0 : hits.length / mappedRows.length;
  const report: RegexReport = {
    ok: true,
    mapped: {
      total: hits.length,
      share: Number(share.toFixed(4)),
      byPayee: [...byPayee.entries()]
        .map(([p, count]) => ({ payee: p, count }))
        .sort((a, b) => b.count - a.count),
    },
    unmappedWouldCatch: replica.db
      .select({ description: bankTx.description })
      .from(bankTx)
      .where(isNull(bankTx.payeeId))
      .all()
      .filter((r) => re.test(r.description)).length,
    samples: hits.slice(0, 8).map((h) => h.description),
    overlappingRules: replica.db
      .select({ id: matchingRule.id, label: matchingRule.label, pattern: matchingRule.pattern })
      .from(matchingRule)
      .all()
      .filter((r) => {
        try {
          const other = new RegExp(r.pattern, 'i');
          return hits.some((h) => other.test(h.description));
        } catch {
          return false;
        }
      }),
  };

  if (mappedRows.length >= MIN_HISTORY_FOR_SHARE && share > MAX_MAPPED_SHARE) {
    return {
      ...report,
      ok: false,
      reason:
        `pattern matches ${(share * 100).toFixed(1)}% of all mapped history ` +
        `(limit ${MAX_MAPPED_SHARE * 100}%) — it is far too broad to be a merchant rule`,
    };
  }

  return report;
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * The agent's read surface over the local replica.
 *
 * All four are readOnlyHint so the SDK may run them in parallel, and none of them accepts raw SQL —
 * the agent gets these four questions and nothing else.
 */
export function buildReadTools(replica: ReplicaDb) {
  const findSimilarTransactions = tool(
    'find_similar_transactions',
    'Search already-mapped transaction history for a merchant. Use the distinctive part of the ' +
      'merchant name, not the whole description — descriptions carry branch, city and reference ' +
      'suffixes that vary. Returns the payee and category each match resolved to.',
    {
      query: z.string().describe('Substring to look for, case-insensitive'),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async (args) => {
      const rows = replica.db
        .select({
          description: bankTx.description,
          date: bankTx.date,
          payee: payee.name,
          category: category.name,
          payeeId: bankTx.payeeId,
          categoryId: bankTx.categoryId,
        })
        .from(bankTx)
        .innerJoin(payee, eq(payee.id, bankTx.payeeId))
        .innerJoin(category, eq(category.id, bankTx.categoryId))
        .where(sql`lower(${bankTx.description}) LIKE ${'%' + args.query.toLowerCase() + '%'}`)
        .orderBy(sql`${bankTx.date} DESC`)
        .limit(args.limit)
        .all();
      return json({ count: rows.length, matches: rows });
    },
    { annotations: { readOnlyHint: true } },
  );

  const searchPayees = tool(
    'search_payees',
    'Find existing payees by name. Returns each one with how many transactions it has and the ' +
      'distinct trailing country codes seen across them — use that to tell a global brand billed ' +
      'through several countries (one payee) from a company with separate national entities. ' +
      'Also returns where the payee itself is, once that has been looked up: locationKind is ' +
      '"local" (one place, named in location), "chain" (branches in one country), "remote" ' +
      '(online or global; country is its head office) or "unknown"; null means not looked up yet.',
    {
      query: z.string().describe('Substring of the payee name, case-insensitive'),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async (args) => {
      const payees = replica.db
        .select({
          id: payee.id,
          name: payee.name,
          country: payee.country,
          location: payee.location,
          locationKind: payee.locationKind,
        })
        .from(payee)
        .where(sql`lower(${payee.name}) LIKE ${'%' + args.query.toLowerCase() + '%'}`)
        .limit(args.limit)
        .all();

      const rows = payees.map((p) => {
        const txs = replica.db
          .select({ description: bankTx.description })
          .from(bankTx)
          .where(eq(bankTx.payeeId, p.id))
          .all();
        const countries = [...new Set(txs.map((t) => trailingCountry(t.description)))]
          .filter((c): c is string => c !== null)
          .sort();
        return {
          id: p.id,
          name: p.name,
          txCount: txs.length,
          countries,
          locationKind: p.locationKind,
          country: p.country,
          location: p.location,
        };
      });
      return json({ count: rows.length, payees: rows });
    },
    { annotations: { readOnlyHint: true } },
  );

  const listMatchingRules = tool(
    'list_matching_rules',
    'List every merchant matching rule, in priority order. Check this before writing a new rule: ' +
      'a near-miss usually means an existing rule has gone stale and should be widened instead.',
    {},
    async () => {
      const rows = replica.db
        .select({
          id: matchingRule.id,
          label: matchingRule.label,
          pattern: matchingRule.pattern,
          priority: matchingRule.priority,
          enabled: matchingRule.enabled,
        })
        .from(matchingRule)
        .orderBy(matchingRule.priority)
        .all();
      return json({ count: rows.length, rules: rows });
    },
    { annotations: { readOnlyHint: true } },
  );

  const testRegexTool = tool(
    'test_regex',
    'Evaluate a candidate rule pattern against real history BEFORE creating or updating a rule. ' +
      'Reports how many mapped transactions it hits and whether they agree on one payee — ' +
      'disagreement means the pattern is too broad. Also reports how many unmapped rows it would ' +
      'resolve, and rejects patterns that are invalid, pathologically slow, or match nearly ' +
      'everything.',
    { pattern: z.string().describe('JS regex source. No delimiters, no flags.') },
    async (args) => json(testRegex(replica, args.pattern)),
    { annotations: { readOnlyHint: true } },
  );

  return [findSimilarTransactions, searchPayees, listMatchingRules, testRegexTool];
}
