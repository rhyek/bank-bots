import { Module } from '@nestjs/common';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { TxMatcher } from '~/payee-resolver/tx-matcher.service';
import { PayeeResolver } from '~/payee-resolver/payee-resolver.service';

// Depends on the replica CLIENT only, never on replica-sync — replica-sync drives this module, so
// importing it here would close a dependency cycle.
@Module({
  imports: [ReplicaDbModule],
  providers: [TxMatcher, PayeeResolver],
  exports: [PayeeResolver],
})
export class PayeeResolverModule {}
