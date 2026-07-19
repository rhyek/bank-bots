import { Module } from '@nestjs/common';
import { ReplicaSyncModule } from '~/replica-sync/replica-sync.module';
import { StatusModule } from '~/status/status.module';

// ReplicaDbModule isn't listed here — ReplicaSyncModule imports it, and so does PayeeResolverModule.
@Module({ imports: [StatusModule, ReplicaSyncModule] })
export class AppModule {}
