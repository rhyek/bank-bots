import { Module } from '@nestjs/common';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { ReplicaStatusController } from '~/replica-sync/replica-status.controller';
import { ReplicaSync } from '~/replica-sync/replica-sync.service';

// Keeps the local SQLite replica current: a delta sync on boot + real-time LISTEN/NOTIFY updates
// for payee, category, bank_tx, matching_rule. See replica-sync.service.ts.
//
// It announces work through AppEvents (provided globally by EventsModule) rather than calling a
// consumer directly, so it has no knowledge of payee-resolver or anything else downstream.
@Module({
  imports: [ReplicaDbModule],
  controllers: [ReplicaStatusController],
  providers: [ReplicaSync],
})
export class ReplicaSyncModule {}
