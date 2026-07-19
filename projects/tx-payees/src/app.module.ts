import { Module } from '@nestjs/common';
import { EventsModule } from '~/events/events.module';
import { PayeeResolverModule } from '~/payee-resolver/payee-resolver.module';
import { ReplicaSyncModule } from '~/replica-sync/replica-sync.module';
import { StatusModule } from '~/status/status.module';

// PayeeResolverModule is listed explicitly: replica-sync no longer imports it (they talk only over
// AppEvents), so nothing else would pull it into the graph. ReplicaDbModule arrives transitively
// via both; EventsModule is @Global, so AppEvents is injectable anywhere.
@Module({ imports: [EventsModule, StatusModule, ReplicaSyncModule, PayeeResolverModule] })
export class AppModule {}
