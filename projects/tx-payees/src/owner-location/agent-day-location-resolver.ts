import { Injectable } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { idleTimeoutMs } from '~/agent/agent-config';
import { AgentModels } from '~/agent/agent-models.service';
import { runStructuredAgent } from '~/agent/structured-agent';
import {
  DayAnswers,
  DayLocationResolver,
  type DayAnswer,
  type DayRun,
} from '~/owner-location/day-location-resolver';
import { DAY_SYSTEM_PROMPT, buildDayPrompt } from '~/owner-location/day-prompt';

/**
 * The Agent SDK implementation of the day location resolver.
 *
 * It has no tools at all, built-in or otherwise: everything it may use is in the prompt, and there
 * is nothing to look up. The turn limit only leaves room for the SDK's structured-output retries.
 */
@Injectable()
export class AgentDayLocationResolver extends DayLocationResolver {
  constructor(
    private readonly models: AgentModels,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async resolve(run: DayRun): Promise<DayAnswer[]> {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error('no CLAUDE_CODE_OAUTH_TOKEN');
    }
    const answer = await runStructuredAgent({
      prompt: buildDayPrompt(run.dates, run.evidence),
      systemPrompt: DAY_SYSTEM_PROMPT,
      schema: DayAnswers,
      ...this.models.location(),
      builtinTools: [],
      maxTurns: 6,
      idleTimeoutMs: idleTimeoutMs(),
      logger: this.logger,
    });
    return answer.days;
  }
}
