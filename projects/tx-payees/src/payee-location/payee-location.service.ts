import { Injectable } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { eq, sql } from 'drizzle-orm';
import { placeField } from '~/owner-location/place-field';
import { bankTx, payee } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import {
  PayeeLocationMatcher,
  checkPayeeLocation,
  type PayeeLocationAnswer,
  type PayeeLocationInput,
} from '~/payee-location/payee-location-matcher';
import { PayeeLocationWriter } from '~/payee-location/payee-location-writer';

const MAX_SAMPLES = 10;

/** The transaction that prompted a payee lookup, and where the owner was when it was bought. */
export interface PayeeLocationTrigger {
  txId: string;
  date: string;
  description: string;
  ownerCountry: string | null;
  ownerLocation: string | null;
}

/**
 * Works out where a payee is, once per payee.
 *
 * `payee.location_kind` is the "already looked up" marker: this runs only while it is NULL, and
 * every answer sets it — `unknown` included, which is as terminal as any other. To re-ask, set it
 * back to NULL by hand.
 */
@Injectable()
export class PayeeLocationService {
  constructor(
    private readonly replica: ReplicaDb,
    private readonly matcher: PayeeLocationMatcher,
    private readonly writer: PayeeLocationWriter,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * Look the payee up and record the answer. Resolves to `null`, having done nothing, when the
   * payee already has a kind or no longer exists.
   *
   * Throws when the agent fails or answers inconsistently. Nothing is recorded then, so the payee
   * stays NULL and is asked about again on a later sweep.
   */
  async resolve(
    payeeId: string,
    trigger: PayeeLocationTrigger,
  ): Promise<PayeeLocationAnswer | null> {
    const row = this.replica.db
      .select({ name: payee.name, locationKind: payee.locationKind })
      .from(payee)
      .where(eq(payee.id, payeeId))
      .get();
    if (!row || row.locationKind !== null) {
      return null;
    }

    const answer = checkPayeeLocation(
      await this.matcher.match(this.input(payeeId, row.name, trigger)),
    );
    await this.writer.record(payeeId, answer, trigger.txId);

    this.logger.info(
      {
        payeeId,
        payeeName: row.name,
        kind: answer.kind,
        country: answer.country,
        location: answer.location,
        summary: answer.summary,
      },
      'payee located',
    );
    return answer;
  }

  private input(payeeId: string, name: string, trigger: PayeeLocationTrigger): PayeeLocationInput {
    const txs = this.replica.db
      .select({
        date: bankTx.date,
        description: bankTx.description,
        amountCents: bankTx.amountCents,
      })
      .from(bankTx)
      .where(eq(bankTx.payeeId, payeeId))
      .orderBy(sql`${bankTx.date} DESC`, sql`${bankTx.id} DESC`)
      .all();

    // Most recent first, but one line per distinct description before any repeat: ten copies of the
    // same branch would hide the other nine branches of a chain.
    const seen = new Set<string>();
    const distinct = txs.filter((tx) => !seen.has(tx.description) && seen.add(tx.description));
    const repeats = txs.filter((tx) => !distinct.includes(tx));
    const samples = [...distinct, ...repeats]
      .slice(0, MAX_SAMPLES)
      .sort((a, b) => b.date.localeCompare(a.date));

    const fields = new Map<string, number>();
    for (const tx of txs) {
      const place = placeField(tx.description);
      const field = place ? `${place.shape} "${place.value}"` : 'no place field';
      fields.set(field, (fields.get(field) ?? 0) + 1);
    }

    return {
      name,
      txCount: txs.length,
      firstDate: txs.at(-1)?.date ?? null,
      lastDate: txs[0]?.date ?? null,
      samples,
      placeFields: [...fields.entries()]
        .map(([field, count]) => ({ field, count }))
        .sort((a, b) => b.count - a.count),
      trigger: {
        date: trigger.date,
        description: trigger.description,
        ownerCountry: trigger.ownerCountry,
        ownerLocation: trigger.ownerLocation,
      },
    };
  }
}
