import { Injectable } from '@nestjs/common';
import {
  payee as pgPayee,
  payeeLocationResult as pgPayeeLocationResult,
  db as pgDb,
  eq as pgEq,
} from '@bank-bots/db';
import { v7 as uuidv7 } from 'uuid';
import { ReplicaSettled } from '~/events/replica-settled.service';
import type { PayeeLocationAnswer } from '~/payee-location/payee-location-matcher';

/**
 * The payee location matcher's writes, kept apart so its service can be tested without Postgres.
 */
@Injectable()
export class PayeeLocationWriter {
  constructor(private readonly settle: ReplicaSettled) {}

  /**
   * Set the payee's place, and append the decision to its audit log.
   *
   * The payee update goes through the replica barrier: `location_kind` is the "already looked up"
   * marker, and the next transaction of the same payee reads it from SQLite a moment later. Without
   * the wait it would still read NULL and run the agent a second time.
   */
  async record(payeeId: string, answer: PayeeLocationAnswer, triggerTxId: string): Promise<void> {
    await this.settle.around('payee', payeeId, async () => {
      await pgDb
        .update(pgPayee)
        .set({ country: answer.country, location: answer.location, locationKind: answer.kind })
        .where(pgEq(pgPayee.id, payeeId));
    });
    await pgDb.insert(pgPayeeLocationResult).values({
      id: uuidv7(),
      payeeId,
      kind: answer.kind,
      country: answer.country,
      location: answer.location,
      data: { summary: answer.summary, confidence: answer.confidence, triggerTxId },
    });
  }
}
