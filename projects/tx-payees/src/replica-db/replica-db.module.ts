import { Module } from '@nestjs/common';
import { ReplicaDb } from '~/replica-db/replica-db.service';

// Owns the local SQLite replica connection and nothing else. Deliberately separate from
// replica-sync so feature modules can read the replica without depending on replication itself —
// replica-sync drives payee-resolver, and payee-resolver reads the replica, so a single combined module
// would be a dependency cycle.
@Module({
  providers: [ReplicaDb],
  exports: [ReplicaDb],
})
export class ReplicaDbModule {}
