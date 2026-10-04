import { Injectable } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { idleTimeoutMs } from '~/agent/agent-config';
import { AgentModels } from '~/agent/agent-models.service';
import { runStructuredAgent } from '~/agent/structured-agent';
import {
  PLACE_SYSTEM_PROMPT,
  PlaceAnswers,
  PlaceFieldResolver,
  buildPlacePrompt,
  type PlaceEntry,
  type PlaceRequest,
} from '~/owner-location/place-resolver';

/**
 * The Agent SDK implementation of the place resolver. No tools: a truncated town name is something
 * the model either recognizes or should answer null for.
 */
@Injectable()
export class AgentPlaceFieldResolver extends PlaceFieldResolver {
  constructor(
    private readonly models: AgentModels,
    private readonly logger: StructuredLoggerService,
  ) {
    super();
  }

  async resolve(request: PlaceRequest): Promise<PlaceEntry[]> {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error('no CLAUDE_CODE_OAUTH_TOKEN');
    }
    const answer = await runStructuredAgent({
      prompt: buildPlacePrompt(request),
      systemPrompt: PLACE_SYSTEM_PROMPT,
      schema: PlaceAnswers,
      ...this.models.location(),
      builtinTools: [],
      maxTurns: 6,
      idleTimeoutMs: idleTimeoutMs(),
      logger: this.logger,
    });
    return answer.fields;
  }
}
