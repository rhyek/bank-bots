import { Module } from '@nestjs/common';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { TxMatcher } from '~/tx-payees/tx-matcher.service';
import { TxPayees } from '~/tx-payees/tx-payees.service';

// Depends on the replica CLIENT only, never on replica-sync — replica-sync drives this module, so
// importing it here would close a dependency cycle.
@Module({
  imports: [ReplicaDbModule],
  providers: [TxMatcher, TxPayees],
  exports: [TxPayees],
})
export class TxPayeesModule {}
