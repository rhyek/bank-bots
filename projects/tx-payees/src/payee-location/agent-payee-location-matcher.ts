import { Injectable } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { idleTimeoutMs } from '~/agent/agent-config';
import { AgentModels } from '~/agent/agent-models.service';
import { runStructuredAgent } from '~/agent/structured-agent';
import {
  PayeeLocationAnswer,
  PayeeLocationMatcher,
  type PayeeLocationInput,
} from '~/payee-location/payee-location-matcher';
import { PAYEE_LOCATION_SYSTEM_PROMPT, buildPayeeLocationPrompt } from '~/payee-location/prompt';

/**
 * The Agent SDK implementation of the payee location matcher.
 *
 * WebSearch is its only tool. It reads nothing from the database itself — what it needs about the
 * payee is in the prompt — and it writes nothing: PayeeLocationService records the answer.
 */
@Injectable()
export class AgentPayeeLocationMatcher extends PayeeLocationMatcher {
  constructor(
    private readonly models: AgentModels,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async match(input: PayeeLocationInput): Promise<PayeeLocationAnswer> {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error('no CLAUDE_CODE_OAUTH_TOKEN');
    }
    return runStructuredAgent({
      prompt: buildPayeeLocationPrompt(input),
      systemPrompt: PAYEE_LOCATION_SYSTEM_PROMPT,
      schema: PayeeLocationAnswer,
      ...this.models.location(),
      builtinTools: ['WebSearch'],
      maxTurns: 12,
      idleTimeoutMs: idleTimeoutMs(),
      logger: this.logger,
    });
  }
}
