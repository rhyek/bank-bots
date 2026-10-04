import { Injectable, type OnModuleInit } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { idleTimeoutMs } from '~/agent/agent-config';
import { AgentModels } from '~/agent/agent-models.service';
import { runStructuredAgent } from '~/agent/structured-agent';
import { bankTx, category, payee } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import { ReplicaSettled } from '~/events/replica-settled.service';
import { OwnerLocationService } from '~/owner-location/owner-location.service';
import { TxAiResolver, type MatchOutcome, type MatchableTx } from '~/payee-resolver/match-outcome';
import { buildReadTools } from '~/payee-resolver/ai/read-tools';
import { buildWriteTools } from '~/payee-resolver/ai/write-tools';
import { SYSTEM_PROMPT, buildCategoryList, buildUserPrompt } from '~/payee-resolver/ai/prompt';
import { Answer } from '~/payee-resolver/ai/output-schema';

const MAX_TURNS = 25;

/**
 * The third matching tier: an agent, reached only when exact description and every regex rule have
 * missed.
 *
 * Its capability surface is exactly the eight tools built here plus WebSearch: naming WebSearch as
 * the only built-in removes every other one — Bash, Read, Write, Edit, Glob, Grep — from the
 * agent's context entirely. The session itself is run by runStructuredAgent, which holds the
 * options every agent in this app shares.
 */
@Injectable()
export class TxAiMatcher extends TxAiResolver implements OnModuleInit {
  private calls = 0;

  constructor(
    private readonly replica: ReplicaDb,
    private readonly settle: ReplicaSettled,
    private readonly ownerLocation: OwnerLocationService,
    private readonly models: AgentModels,
    private readonly logger: StructuredLoggerService,
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
      this.logger.warn(
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
      this.logger.info({ calls: this.calls }, 'sweep finished; agent call budget reset');
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
        // Where the owner was around this date. Null when unavailable — never a reason to fail.
        location: await this.ownerLocation.describe(row.date),
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

  private run(prompt: string, server: ReturnType<typeof createSdkMcpServer>): Promise<Answer> {
    return runStructuredAgent({
      prompt,
      systemPrompt: `${SYSTEM_PROMPT}\n${buildCategoryList(this.replica)}`,
      schema: Answer,
      ...this.models.payeeMatcher(),
      // Naming WebSearch leaves exactly one built-in in context; [] would remove it too.
      builtinTools: ['WebSearch'],
      mcpServers: { txp: server },
      maxTurns: MAX_TURNS,
      idleTimeoutMs: idleTimeoutMs(),
      logger: this.logger,
    });
  }
}
