import { Global, Module } from '@nestjs/common';
import { AppEvents } from '~/events/app-events';

// Global so any feature module can inject AppEvents without restating the import, and — more to the
// point — so publishers and subscribers never have to reference one another's modules.
@Global()
@Module({
  providers: [AppEvents],
  exports: [AppEvents],
})
export class EventsModule {}
