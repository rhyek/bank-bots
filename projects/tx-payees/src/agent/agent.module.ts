import { Module } from '@nestjs/common';
import { AgentModels } from '~/agent/agent-models.service';

// What every agent in the app shares. One instance for the whole app, however many modules import
// this: the model is looked up once, at boot, and all four agents use that answer.
@Module({
  providers: [AgentModels],
  exports: [AgentModels],
})
export class AgentModule {}
