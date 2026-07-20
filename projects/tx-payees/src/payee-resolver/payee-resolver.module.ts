import { Module } from '@nestjs/common';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { TxMatcher } from '~/payee-resolver/tx-matcher.service';
import { TxAiMatcher } from '~/payee-resolver/tx-ai-matcher.service';
import { TxAiResolver } from '~/payee-resolver/match-outcome';
import { MatchWriter } from '~/payee-resolver/match-writer.service';
import { PayeeResolver } from '~/payee-resolver/payee-resolver.service';

// Reads the replica and subscribes to AppEvents. It neither imports replica-sync nor is imported by
// it — the two communicate only through the event bus, so either can change without touching the
// other. Nothing outside consumes PayeeResolver directly, so it isn't exported.
//
// TxAiResolver is an abstract class used as the injection token: TxMatcher depends on the contract,
// TxAiMatcher supplies the Agent SDK implementation, and tests substitute a stub so tiers 1 and 2
// can be exercised with no agent, no network and no API token.
@Module({
  imports: [ReplicaDbModule],
  providers: [
    TxMatcher,
    MatchWriter,
    PayeeResolver,
    { provide: TxAiResolver, useClass: TxAiMatcher },
  ],
})
export class PayeeResolverModule {}
