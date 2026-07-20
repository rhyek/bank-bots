import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  category as pgCategory,
  categoryGroup as pgCategoryGroup,
  matchingRule as pgMatchingRule,
  payee as pgPayee,
  db as pgDb,
  eq as pgEq,
} from '@bank-bots/db';
import { v7 as uuidv7 } from 'uuid';
import { matchingRule } from '~/replica-db/replica-schema';
import type { ReplicaDb } from '~/replica-db/replica-db.service';
import type { ReplicaSettled } from '~/events/replica-settled.service';
import { testRegex } from '~/payee-resolver/ai/read-tools';

/**
 * What the agent actually changed during one run.
 *
 * Recorded here, as each tool fires, rather than taken from the model's own summary — this is the
 * ground truth that lands in matcher_result.data.
 */
export interface SideEffects {
  created: { payeeId?: string; categoryId?: string; matchingRuleId?: string };
  updated: { matchingRuleId?: string };
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/**
 * The agent's write surface.
 *
 * Four named operations rather than a database handle: each one validates its own input, mints its
 * own uuidv7, and goes through the replica barrier so the next transaction in the queue — and the
 * rest of this agent run — can see it. The agent never holds a connection.
 */
export function buildWriteTools(deps: { replica: ReplicaDb; settle: ReplicaSettled }) {
  const { replica, settle } = deps;
  const sideEffects: SideEffects = { created: {}, updated: {} };

  const createPayee = tool(
    'create_payee',
    'Create a new payee. Use a clean, human-readable name matching the existing style ' +
      '("PlayStation", not "PLAYSTATION 650-2"). For a separate national entity of a company that ' +
      'already exists, use the "<Name> <CC>" convention, e.g. "Claro CR".',
    { name: z.string().min(1).describe('Display name for the payee') },
    async (args) => {
      const name = args.name.trim();
      if (!name) {
        return fail('name cannot be empty');
      }
      const id = uuidv7();
      await settle.around('payee', id, async () => {
        await pgDb.insert(pgPayee).values({ id, name });
      });
      sideEffects.created.payeeId = id;
      return ok({ id, name });
    },
  );

  const createCategory = tool(
    'create_category',
    'Create a new budget category inside an existing group. Only do this when no existing category ' +
      'fits at all — prefer selecting one from the list in your instructions.',
    {
      name: z.string().min(1),
      groupId: z.string().min(1).describe('id of an existing category group'),
    },
    async (args) => {
      const group = await pgDb
        .select({ id: pgCategoryGroup.id, name: pgCategoryGroup.name })
        .from(pgCategoryGroup)
        .where(pgEq(pgCategoryGroup.id, args.groupId));
      if (group.length === 0) {
        return fail(`no category group with id ${args.groupId}; pick one from your instructions`);
      }
      const id = uuidv7();
      await settle.around('category', id, async () => {
        await pgDb
          .insert(pgCategory)
          .values({ id, name: args.name.trim(), groupId: args.groupId, hidden: false });
      });
      sideEffects.created.categoryId = id;
      return ok({ id, name: args.name.trim(), group: group[0].name });
    },
  );

  /** Shared gate for both rule-writing tools. Liveness, not judgment: see testRegex. */
  function guardPattern(pattern: string): string | null {
    const report = testRegex(replica, pattern);
    return report.ok ? null : (report.reason ?? 'pattern rejected');
  }

  const createMatchingRule = tool(
    'create_matching_rule',
    'Create a merchant matching rule. A rule only decides WHERE to look — the payee always comes ' +
      'from the most recent already-mapped transaction the pattern matches, never from the rule. ' +
      'Run test_regex first. Priorities step by 10; put a specific sub-brand rule before the ' +
      'general one and give the general one a negative lookahead.',
    {
      label: z.string().min(1).describe('Short unique label, e.g. "playstation"'),
      pattern: z.string().min(1).describe('JS regex source. No delimiters, no flags.'),
      priority: z.number().int().describe('Lower runs first; existing rules step by 10'),
    },
    async (args) => {
      const rejected = guardPattern(args.pattern);
      if (rejected) {
        return fail(`pattern rejected: ${rejected}`);
      }
      const clash = replica.db
        .select({ id: matchingRule.id })
        .from(matchingRule)
        .where(pgEq(matchingRule.label, args.label))
        .get();
      if (clash) {
        return fail(
          `a rule labelled "${args.label}" already exists — update it instead of adding a second`,
        );
      }
      const id = uuidv7();
      await settle.around('matching_rule', id, async () => {
        await pgDb.insert(pgMatchingRule).values({
          id,
          label: args.label,
          pattern: args.pattern,
          priority: args.priority,
          enabled: true,
        });
      });
      sideEffects.created.matchingRuleId = id;
      return ok({ id, label: args.label, pattern: args.pattern, priority: args.priority });
    },
  );

  const updateMatchingRule = tool(
    'update_matching_rule',
    'Widen or correct an existing rule. Prefer this over adding a near-duplicate: a rule that ' +
      'used to match and no longer does has usually gone stale because the vendor changed a ' +
      'reference format.',
    {
      id: z.string().min(1),
      pattern: z.string().min(1).optional(),
      priority: z.number().int().optional(),
      enabled: z.boolean().optional(),
    },
    async (args) => {
      const existing = replica.db
        .select({ id: matchingRule.id, label: matchingRule.label })
        .from(matchingRule)
        .where(pgEq(matchingRule.id, args.id))
        .get();
      if (!existing) {
        return fail(`no rule with id ${args.id}; call list_matching_rules to get valid ids`);
      }
      if (args.pattern !== undefined) {
        const rejected = guardPattern(args.pattern);
        if (rejected) {
          return fail(`pattern rejected: ${rejected}`);
        }
      }
      const patch: Record<string, unknown> = {};
      if (args.pattern !== undefined) {
        patch.pattern = args.pattern;
      }
      if (args.priority !== undefined) {
        patch.priority = args.priority;
      }
      if (args.enabled !== undefined) {
        patch.enabled = args.enabled;
      }
      if (Object.keys(patch).length === 0) {
        return fail('nothing to update: pass at least one of pattern, priority, enabled');
      }

      await settle.around('matching_rule', args.id, async () => {
        await pgDb.update(pgMatchingRule).set(patch).where(pgEq(pgMatchingRule.id, args.id));
      });
      sideEffects.updated.matchingRuleId = args.id;
      return ok({ id: args.id, label: existing.label, ...patch });
    },
  );

  return {
    tools: [createPayee, createCategory, createMatchingRule, updateMatchingRule],
    sideEffects,
  };
}
