import { Module } from '@nestjs/common';
import { AgentModule } from '~/agent/agent.module';
import { LocationModule } from '~/location/location.module';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';
import { AgentDayLocationResolver } from '~/owner-location/agent-day-location-resolver';
import { DayLocationResolver } from '~/owner-location/day-location-resolver';
import { OwnerDayStore } from '~/owner-location/owner-day-store';
import { OwnerLocationService } from '~/owner-location/owner-location.service';
import { AgentPlaceFieldResolver } from '~/owner-location/agent-place-field-resolver';
import { PlaceFieldStore } from '~/owner-location/place-field-store';
import { PlaceFieldResolver } from '~/owner-location/place-resolver';

// Where the owner was: per day (resolved by an agent, stored in owner_day_location) and per
// transaction (looked up from those days, no agent). It reads the tracker through `location` and
// card charges through the replica, and writes nothing but its own days — payee-resolver decides
// what to do with a transaction's location.
//
// DayLocationResolver and PlaceFieldResolver are abstract classes used as injection tokens, like
// TxAiResolver.
@Module({
  imports: [AgentModule, LocationModule, ReplicaDbModule],
  providers: [
    OwnerLocationService,
    OwnerDayStore,
    PlaceFieldStore,
    { provide: DayLocationResolver, useClass: AgentDayLocationResolver },
    { provide: PlaceFieldResolver, useClass: AgentPlaceFieldResolver },
  ],
  exports: [OwnerLocationService],
})
export class OwnerLocationModule {}
