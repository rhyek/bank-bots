import type { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface StructuredAgentRun<T> {
  prompt: string;
  systemPrompt: string;
  /** Validates the answer; its JSON Schema is what the agent is held to. */
  schema: z.ZodType<T>;
  model: string;
  effort: string;
  /**
   * The built-in tools left in the agent's context. `[]` removes every one of them — Bash, Read,
   * Write, Edit, Glob, Grep, WebSearch — so a caller that wants web search names it.
   */
  builtinTools: string[];
  mcpServers?: Options['mcpServers'];
  maxTurns: number;
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
  idleTimeoutMs: number;
  logger: StructuredLoggerService;
}

/**
 * Run one Agent SDK session to a validated, structured answer.
 *
 * Shared by every agent in this app (the payee matcher, the day location resolver, the payee
 * location matcher) so the options that are load-bearing are set in exactly one place:
 *
 * - `settingSources: []` stops the SDK loading ~/.claude, project .claude/, or this repo's
 *   CLAUDE.md, so agent behavior can't drift with the owner's dotfiles.
 * - `effort` is passed explicitly rather than left to the default: the SDK has silently injected a
 *   flag-driven effort default before (anthropics/claude-agent-sdk-typescript#214).
 * - The JSON Schema targets draft-07, which is what the SDK validates; Zod emits 2020-12 by
 *   default, and the mismatch fails the run at startup with a schema error.
 *
 * Anything short of a parsed answer throws. Callers decide what a failed run means; none of them
 * may record it as a verdict.
 */
export async function runStructuredAgent<T>(run: StructuredAgentRun<T>): Promise<T> {
  const mcpNames = Object.keys(run.mcpServers ?? {});
  const q = query({
    prompt: run.prompt,
    options: {
      model: run.model,
      effort: run.effort as Options['effort'],
      systemPrompt: run.systemPrompt,
      tools: run.builtinTools,
      settingSources: [],
      mcpServers: run.mcpServers,
      allowedTools: [...run.builtinTools, ...mcpNames.map((name) => `mcp__${name}__*`)],
      outputFormat: {
        type: 'json_schema',
        schema: z.toJSONSchema(run.schema, { target: 'draft-7' }) as Record<string, unknown>,
      },
      maxTurns: run.maxTurns,
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
      run.logger.warn(
        { idleTimeoutMs: run.idleTimeoutMs },
        'agent produced no output; closing the session',
      );
      q.close();
    }, run.idleTimeoutMs);
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
      const parsed = run.schema.safeParse(message.structured_output);
      if (!parsed.success) {
        throw new Error(`agent output failed validation: ${parsed.error.message}`);
      }
      return parsed.data;
    }
    // Closing the session ends the iterator, so a stall lands here rather than at the timer.
    throw new Error(
      stalled
        ? `agent stalled (no output for ${run.idleTimeoutMs}ms)`
        : 'agent produced no result message',
    );
  } finally {
    clearTimeout(stall);
  }
}
