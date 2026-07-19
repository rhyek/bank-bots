import { Module } from '@nestjs/common';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { ReplicaStatusController } from '~/replica-sync/replica-status.controller';
import { ReplicaSync } from '~/replica-sync/replica-sync.service';
import { TxPayeesModule } from '~/tx-payees/tx-payees.module';

// Keeps the local SQLite replica current: a delta sync on boot + real-time LISTEN/NOTIFY updates
// for payee, category, bank_tx. See replica-sync.service.ts.
@Module({
  imports: [ReplicaDbModule, TxPayeesModule],
  controllers: [ReplicaStatusController],
  providers: [ReplicaSync],
})
export class ReplicaSyncModule {}
