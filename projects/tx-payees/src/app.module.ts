import { Module } from '@nestjs/common';
import { StructuredLoggerModule } from '@rhyek/nestjs-utils';
import { EventsModule } from '~/events/events.module';
import { PayeeResolverModule } from '~/payee-resolver/payee-resolver.module';
import { ReplicaSyncModule } from '~/replica-sync/replica-sync.module';
import { StatusModule } from '~/status/status.module';

// PayeeResolverModule is listed explicitly: replica-sync no longer imports it (they talk only over
// AppEvents), so nothing else would pull it into the graph. ReplicaDbModule arrives transitively
// via both; EventsModule is @Global, so AppEvents is injectable anywhere.
//
// StructuredLoggerModule is @Global too — one import here makes StructuredLoggerService injectable
// in every module. No options: this service has no inbound auth and no request bodies worth
// stripping, so the built-in credential redaction applies as-is and the level comes from
// LOG_LEVEL. When it does need a knob (a house-specific header, a body path to strip, a mixin),
// put it in `logger/logging.options.ts` and pass it to `forRoot`.
@Module({
  imports: [
    StructuredLoggerModule.forRoot(),
    EventsModule,
    StatusModule,
    ReplicaSyncModule,
    PayeeResolverModule,
  ],
})
export class AppModule {}
