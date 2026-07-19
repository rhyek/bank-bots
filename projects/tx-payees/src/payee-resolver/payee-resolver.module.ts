import { Module } from '@nestjs/common';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { TxMatcher } from '~/payee-resolver/tx-matcher.service';
import { PayeeResolver } from '~/payee-resolver/payee-resolver.service';

// Reads the replica and subscribes to AppEvents. It neither imports replica-sync nor is imported by
// it — the two communicate only through the event bus, so either can change without touching the
// other. Nothing outside consumes PayeeResolver directly, so it isn't exported.
@Module({
  imports: [ReplicaDbModule],
  providers: [TxMatcher, PayeeResolver],
})
export class PayeeResolverModule {}
