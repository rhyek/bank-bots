import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { bankTx, category, payee } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import { ReplicaSettled } from '~/events/replica-settled.service';
import { TxAiResolver, type MatchOutcome, type MatchableTx } from '~/payee-resolver/match-outcome';
import { buildReadTools } from '~/payee-resolver/ai/read-tools';
import { buildWriteTools } from '~/payee-resolver/ai/write-tools';
import { SYSTEM_PROMPT, buildCategoryList, buildUserPrompt } from '~/payee-resolver/ai/prompt';
import { Answer, answerJsonSchema } from '~/payee-resolver/ai/output-schema';

const DEFAULTS = {
  model: 'claude-sonnet-5',
  effort: 'medium',
  maxTurns: 25,
  /**
   * Idle timeout, NOT a total-duration cap.
   *
   * A wall-clock cap punishes the wrong thing: an agent researching an unfamiliar merchant across
   * several web searches is working, and killing it at N seconds throws away everything it has done.
   * What actually needs catching is a run that has *stopped producing output*. So the clock is reset
   * by every message the session emits, and only fires on genuine silence.
   *
   * Total runtime stays bounded by maxTurns, so there is no need for a second ceiling.
   */
  idleTimeoutMs: 120_000,
} as const;

/**
 * The third matching tier: an agent, reached only when exact description and every regex rule have
 * missed.
 *
 * Its capability surface is exactly the eight tools built here plus WebSearch. `tools: ['WebSearch']`
 * removes every other built-in — Bash, Read, Write, Edit, Glob, Grep — from the agent's context
 * entirely, and `settingSources: []` stops the SDK loading ~/.claude or this repo's CLAUDE.md, so
 * its behavior can't drift with the owner's dotfiles.
 */
@Injectable()
export class TxAiMatcher extends TxAiResolver implements OnModuleInit {
  private readonly logger = new Logger(TxAiMatcher.name);
  private calls = 0;

  constructor(
    private readonly replica: ReplicaDb,
    private readonly settle: ReplicaSettled,
  ) {
    super();
  }

  /**
   * Diagnose a missing token once, at boot, rather than once per transaction.
   *
   * Without this the backlog sweep logs the same error for all ~150 unmapped rows, which buries the
   * one line that actually tells you what to do. Not fatal: tiers 1 and 2 still work perfectly well
   * without a token, so refusing to start would be a worse trade than running degraded.
   */
  onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('AI tier disabled (TX_AI_ENABLED=false); only exact + rule tiers will run');
      return;
    }
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      this.logger.error(
        'CLAUDE_CODE_OAUTH_TOKEN is not set — the AI tier cannot run. Generate one with ' +
          '`claude setup-token` and add it to .env.local, or set TX_AI_ENABLED=false to silence ' +
          'this. Exact and rule matching are unaffected.',
      );
    }
  }

  private get enabled(): boolean {
    return (process.env.TX_AI_ENABLED ?? 'true') !== 'false';
  }

  /**
   * Unbounded by default.
   *
   * A call cap guards against runaway spend under metered API billing. This runs on a Claude
   * subscription, where there is no per-call charge — the only ceiling is rate limits, and those are
   * self-correcting: a limited call errors, the transaction stays unmapped, the next sweep retries
   * it. Nothing is lost.
   *
   * A default cap bought nothing and cost real availability: once spent, the service kept running
   * while silently skipping every transaction, including newly scraped ones, until restarted.
   *
   * The work is bounded anyway — the backlog is finite, 'none' verdicts stop re-asking, and maxTurns
   * caps any single run. Set the env var to throttle something genuinely large, like a full-history
   * backfill.
   */
  private get maxPerSweep(): number {
    const configured = process.env.TX_AI_MAX_PER_SWEEP;
    return configured ? Number(configured) : Number.POSITIVE_INFINITY;
  }

  /** Start a fresh budget for the next batch of work. Driven by PayeeResolver's queue-idle hook. */
  override resetBudget() {
    if (this.calls > 0) {
      this.logger.log(`sweep finished after ${this.calls} agent call(s); budget reset`);
    }
    this.calls = 0;
  }

  async resolve(tx: MatchableTx): Promise<MatchOutcome> {
    // These three are 'skipped', never 'none' and never a thrown error. 'none' is terminal and would
    // permanently exclude a transaction the tier never looked at; throwing would log an ERROR for
    // every row in the backlog. A skip leaves the transaction exactly as retryable as it was found.
    if (!this.enabled) {
      return { type: 'skipped', reason: 'AI tier disabled (TX_AI_ENABLED=false)' };
    }
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { type: 'skipped', reason: 'no CLAUDE_CODE_OAUTH_TOKEN' };
    }
    if (this.calls >= this.maxPerSweep) {
      return { type: 'skipped', reason: `sweep budget spent (${this.maxPerSweep})` };
    }
    this.calls += 1;

    const row = this.replica.db
      .select({
        description: bankTx.description,
        date: bankTx.date,
        amountCents: bankTx.amountCents,
        bankAccountId: bankTx.bankAccountId,
      })
      .from(bankTx)
      .where(eq(bankTx.id, tx.id))
      .get();
    if (!row) {
      throw new Error(`transaction ${tx.id} vanished from the replica`);
    }

    const readTools = buildReadTools(this.replica);
    const { tools: writeTools, sideEffects } = buildWriteTools({
      replica: this.replica,
      settle: this.settle,
    });

    const server = createSdkMcpServer({
      name: 'txp',
      version: '1.0.0',
      tools: [...readTools, ...writeTools],
    });

    const answer = await this.run(
      buildUserPrompt({
        description: row.description,
        date: row.date,
        amountCents: row.amountCents,
        accountNumber: row.bankAccountId,
      }),
      server,
    );

    if (!answer.matched) {
      return { type: 'none', data: { summary: answer.summary, confidence: answer.confidence } };
    }

    // A self-contradictory answer is a failed run, NOT a 'none' verdict — 'none' is terminal, and a
    // model slip must not permanently exclude a transaction that may well be matchable.
    if (!answer.payeeId || !answer.categoryId) {
      throw new Error(`matched=true but payeeId=${answer.payeeId} categoryId=${answer.categoryId}`);
    }
    this.assertExists(answer.payeeId, answer.categoryId);

    return {
      type: 'ai',
      payeeId: answer.payeeId,
      categoryId: answer.categoryId,
      data: {
        summary: answer.summary,
        confidence: answer.confidence,
        created: sideEffects.created,
        updated: sideEffects.updated,
      },
    };
  }

  /** Both ids must resolve to real rows; a hallucinated id would violate a foreign key downstream. */
  private assertExists(payeeId: string, categoryId: string) {
    const p = this.replica.db
      .select({ id: payee.id })
      .from(payee)
      .where(eq(payee.id, payeeId))
      .get();
    if (!p) {
      throw new Error(`payee ${payeeId} does not exist`);
    }
    const c = this.replica.db
      .select({ id: category.id })
      .from(category)
      .where(eq(category.id, categoryId))
      .get();
    if (!c) {
      throw new Error(`category ${categoryId} does not exist`);
    }
  }

  private async run(
    prompt: string,
    server: ReturnType<typeof createSdkMcpServer>,
  ): Promise<Answer> {
    const idleMs = Number(process.env.TX_AI_IDLE_TIMEOUT_MS ?? DEFAULTS.idleTimeoutMs);
    const q = query({
      prompt,
      options: {
        model: process.env.TX_AI_MODEL ?? DEFAULTS.model,
        // Set explicitly rather than left to the default: the SDK has silently injected a
        // flag-driven effort default before (anthropics/claude-agent-sdk-typescript#214).
        effort: (process.env.TX_AI_EFFORT ?? DEFAULTS.effort) as 'medium',
        systemPrompt: `${SYSTEM_PROMPT}\n${buildCategoryList(this.replica)}`,
        // [] would remove WebSearch too; naming it leaves exactly one built-in in context.
        tools: ['WebSearch'],
        // Do not inherit ~/.claude, project .claude/, or this repo's CLAUDE.md.
        settingSources: [],
        mcpServers: { txp: server },
        allowedTools: ['WebSearch', 'mcp__txp__*'],
        outputFormat: { type: 'json_schema', schema: answerJsonSchema },
        maxTurns: DEFAULTS.maxTurns,
        // `env` REPLACES the subprocess environment rather than merging, so process.env must be
        // spread in or the agent loses PATH and its own auth token.
        env: { ...process.env } as Record<string, string>,
      },
    });

    // Heartbeat: rearmed by every message the session emits, so the clock measures silence rather
    // than duration. A long run that keeps producing tool calls and messages is healthy and is left
    // alone; only a genuinely stalled one is closed.
    let stall: NodeJS.Timeout | undefined;
    let stalled = false;
    const beat = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        stalled = true;
        this.logger.warn(`agent produced no output for ${idleMs}ms; closing the session`);
        q.close();
      }, idleMs);
      stall.unref();
    };
    beat();

    try {
      for await (const message of q) {
        beat();
        if (message.type !== 'result') {
          continue;
        }
        if (message.subtype !== 'success' || !message.structured_output) {
          // Includes error_max_structured_output_retries and the success-with-no-output case, which
          // the SDK docs are explicit must also be treated as a failure.
          throw new Error(`agent returned no structured output (subtype: ${message.subtype})`);
        }
        const parsed = Answer.safeParse(message.structured_output);
        if (!parsed.success) {
          throw new Error(`agent output failed validation: ${parsed.error.message}`);
        }
        return parsed.data;
      }
      // Closing the session ends the iterator, so a stall lands here rather than at the timer.
      throw new Error(
        stalled ? `agent stalled (no output for ${idleMs}ms)` : 'agent produced no result message',
      );
    } finally {
      clearTimeout(stall);
    }
  }
}
