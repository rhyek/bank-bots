import { Global, Module } from '@nestjs/common';
import { AppEvents } from '~/events/app-events';
import { ReplicaSettled } from '~/events/replica-settled.service';
import { ReplicaDbModule } from '~/replica-db/replica-db.module';

// Global so any feature module can inject AppEvents without restating the import, and — more to the
// point — so publishers and subscribers never have to reference one another's modules.
//
// ReplicaSettled lives here rather than with either side because it is pure event plumbing: it turns
// 'replica-sync.row-persisted' into a write barrier without knowing who writes or who waits.
// ReplicaDbModule is imported (not a cycle: replica-db depends on nothing) so ReplicaSettled can
// confirm a write landed by asking the replica directly, rather than trusting an event to arrive.
@Global()
@Module({
  imports: [ReplicaDbModule],
  providers: [AppEvents, ReplicaSettled],
  exports: [AppEvents, ReplicaSettled],
})
export class EventsModule {}
