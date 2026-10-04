import { Injectable, type OnModuleInit } from '@nestjs/common';
import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';

/**
 * The Agent SDK's alias for the newest Sonnet it knows. It is what gets looked up at boot, and what
 * the agents are given when the lookup has no answer: the SDK accepts the alias as a model, so they
 * still run on that same Sonnet, only without its id in the log.
 */
const SONNET_ALIAS = 'sonnet';
const LOOKUP_TIMEOUT_MS = 30_000;

/** What an agent run is given: see StructuredAgentRun. */
export interface AgentSettings {
  model: string;
  effort: string;
}

/** The model id the `sonnet` alias stands for, or undefined when the list does not say. */
export function sonnetModel(models: ModelInfo[]): string | undefined {
  return models.find((model) => model.value === SONNET_ALIAS)?.resolvedModel;
}

/** A prompt stream that never yields, so the session starts and no turn is ever run. */
const NO_PROMPT: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

/**
 * Which model and effort each agent runs on.
 *
 * No Sonnet version is written down in this app. At boot the Agent SDK is asked what its `sonnet`
 * alias resolves to, and every agent uses that id for the life of the process. "Latest" therefore
 * means the newest Sonnet the INSTALLED SDK knows: the alias table ships inside the SDK, so a newer
 * Sonnet arrives with an SDK upgrade and not before. (0.3.214 answered claude-sonnet-5 while
 * 0.3.288 answered claude-sonnet-5-5.)
 *
 * The lookup starts an SDK session and closes it without sending a prompt: no model turn, about a
 * second. It never fails the boot — exact and rule matching need no model at all.
 */
@Injectable()
export class AgentModels implements OnModuleInit {
  private sonnet: string | undefined;

  constructor(private readonly logger: StructuredLoggerService) {}

  async onModuleInit() {
    // Nothing to look up when the model is pinned (TX_LOCATION_MODEL falls back to TX_AI_MODEL), or
    // when there is no token: no agent can run then, and a session without one lists no aliases.
    if (process.env.TX_AI_MODEL || !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      this.sonnet = SONNET_ALIAS;
      return;
    }
    try {
      const model = sonnetModel(await this.supportedModels());
      if (model) {
        this.logger.info({ model }, 'agent model resolved');
      } else {
        this.logger.warn(`the Agent SDK lists no "${SONNET_ALIAS}" model; using the alias itself`);
      }
      this.sonnet = model ?? SONNET_ALIAS;
    } catch (error) {
      this.logger.warn(
        { error: error as Error },
        `could not resolve the agent model; using the "${SONNET_ALIAS}" alias itself`,
      );
      this.sonnet = SONNET_ALIAS;
    }
  }

  /** The payee matcher (TxAiMatcher): it writes rules and picks categories, so it runs at high. */
  payeeMatcher(): AgentSettings {
    return {
      model: process.env.TX_AI_MODEL ?? this.latestSonnet(),
      effort: process.env.TX_AI_EFFORT ?? 'high',
    };
  }

  /**
   * The location agents (the day resolver, the place field resolver and the payee location
   * matcher). They follow the payee matcher's model unless told otherwise, at medium effort: none
   * of them writes rules or picks categories, so they need less deliberation than it does.
   */
  location(): AgentSettings {
    return {
      model: process.env.TX_LOCATION_MODEL ?? process.env.TX_AI_MODEL ?? this.latestSonnet(),
      effort: process.env.TX_LOCATION_EFFORT ?? 'medium',
    };
  }

  private latestSonnet(): string {
    // Agents only run once the replica has synced, which is after every onModuleInit. Reaching
    // this earlier is an ordering bug, and running on an undefined model would hide it.
    if (!this.sonnet) {
      throw new Error('the agent model was read before AgentModels.onModuleInit finished');
    }
    return this.sonnet;
  }

  private async supportedModels(): Promise<ModelInfo[]> {
    const session = query({
      prompt: NO_PROMPT,
      options: {
        settingSources: [],
        tools: [],
        // `env` REPLACES the subprocess environment, so process.env is spread in: see
        // runStructuredAgent.
        env: { ...process.env } as Record<string, string>,
      },
    });
    let expire: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        session.supportedModels(),
        new Promise<never>((_, reject) => {
          expire = setTimeout(
            () => reject(new Error(`the Agent SDK did not answer in ${LOOKUP_TIMEOUT_MS}ms`)),
            LOOKUP_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(expire);
      session.close();
    }
  }
}
