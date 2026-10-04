import { Module } from '@nestjs/common';
import { AgentModule } from '~/agent/agent.module';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { AgentPayeeLocationMatcher } from '~/payee-location/agent-payee-location-matcher';
import { PayeeLocationMatcher } from '~/payee-location/payee-location-matcher';
import { PayeeLocationService } from '~/payee-location/payee-location.service';
import { PayeeLocationWriter } from '~/payee-location/payee-location-writer';

// Where a payee is — as opposed to owner-location, which is where the owner was. It knows nothing
// about days or about how a transaction is located; payee-resolver hands it the transaction's
// location as one more piece of evidence.
//
// PayeeLocationMatcher is an abstract class used as the injection token, like TxAiResolver: the
// service depends on the contract and tests substitute a stub.
@Module({
  imports: [AgentModule, ReplicaDbModule],
  providers: [
    PayeeLocationService,
    PayeeLocationWriter,
    { provide: PayeeLocationMatcher, useClass: AgentPayeeLocationMatcher },
  ],
  exports: [PayeeLocationService],
})
export class PayeeLocationModule {}
