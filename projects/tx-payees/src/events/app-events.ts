import { Injectable } from '@nestjs/common';
import Emittery from 'emittery';

/**
 * The app's event contract: event name -> payload type.
 *
 * An `undefined` payload marks a dataless event, which emittery types so it is emitted as
 * `emit('name')` with no second argument. Anything else requires its payload, and both `emit` and
 * `on` are checked against this map — an unknown name or a mismatched payload is a compile error.
 */
export interface AppEventData {
  /** The replica finished its first full delta sync, so history is complete enough to read. */
  'replica-sync.startup-sync-finished': undefined;
  /**
   * A row was applied to the local replica. Emitted *after* the SQLite write, so a listener that
   * observes it can rely on the replica already reflecting the row — that is what makes it usable
   * as a write barrier (see ReplicaSettled).
   *
   * Deliberately a bare replication fact, not an interpretation: replica-sync reports what it did
   * and each consumer decides what that means. A consumer that wants "there is fresh work" filters
   * for `table === 'bank_tx' && op === 'insert'` itself.
   */
  'replica-sync.row-persisted': { table: string; op: 'insert' | 'update' | 'delete'; id: string };
}

/**
 * Typed application event bus.
 *
 * It lives in its own module so publishers and subscribers never import each other: replica-sync
 * emits, payee-resolver listens, and neither module knows the other exists. Extending Emittery
 * rather than wrapping it keeps the whole typed API (`on`, `once`, `off`, `events`, …) available
 * while staying injectable.
 */
@Injectable()
export class AppEvents extends Emittery<AppEventData> {}
