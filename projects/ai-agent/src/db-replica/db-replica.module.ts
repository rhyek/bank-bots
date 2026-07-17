import { Module } from '@nestjs/common';
import { ReplicaController } from '~/db-replica/replica.controller';
import { ReplicaDb } from '~/db-replica/replica-db.service';
import { ReplicaSync } from '~/db-replica/replica-sync.service';

// Maintains a persistent local SQLite mirror of Postgres `payee`, `category`, `bank_tx`: a delta
// sync on boot + real-time LISTEN/NOTIFY updates. See replica-sync.service.ts.
@Module({
  controllers: [ReplicaController],
  providers: [ReplicaDb, ReplicaSync],
  exports: [ReplicaDb],
})
export class DbReplicaModule {}
