import { Injectable } from '@nestjs/common';
import { StructuredLoggerService } from '@rhyek/nestjs-utils';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { daysBetween, windowDates } from '~/location/location-day';
import { LocationService } from '~/location/location.service';
import { bankTx, payee } from '~/replica-db/replica-schema';
import { ReplicaDb } from '~/replica-db/replica-db.service';
import {
  buildDayEvidence,
  consecutiveRuns,
  evidenceRange,
  type Charge,
} from '~/owner-location/day-evidence';
import { DayLocationResolver, checkDayAnswers } from '~/owner-location/day-location-resolver';
import { OwnerDayStore } from '~/owner-location/owner-day-store';
import { placeField } from '~/owner-location/place-field';
import { PlaceFieldStore } from '~/owner-location/place-field-store';
import {
  PlaceFieldResolver,
  checkPlaceAnswers,
  type PlaceEntry,
} from '~/owner-location/place-resolver';
import type { ResolvedDay } from '~/owner-location/resolved-day';
import {
  WINDOW_DAYS,
  formatOwnerWindow,
  locateTx,
  type PayeePlace,
  type TxLocation,
} from '~/owner-location/tx-location';

/** The most days one resolver call is asked about. */
const MAX_RUN_DAYS = 14;
/**
 * A day resolved at this age or older is final: its charges have posted (the lag tops out near ten
 * days) and the phone has had time to upload. A younger day is provisional.
 */
const FINAL_AFTER_DAYS = 10;
/** How long a provisional answer stands before the day is resolved again. */
const PROVISIONAL_TTL_MS = 24 * 60 * 60 * 1000;
const UTC_OFFSET_MS = -6 * 60 * 60 * 1000;
/** The most city fields one place-resolver call is asked about, and the samples shown for each. */
const MAX_PLACE_FIELDS = 40;
const MAX_PLACE_SAMPLES = 3;

/**
 * Where the owner was, per calendar day and per transaction.
 *
 * "Where was the owner" is a property of a date, not of a charge, so the AI resolves DAYS — a run
 * at a time, once each — and every transaction looks its day up with no AI at all. That is what
 * keeps a year of history to a few dozen agent calls, and keeps two charges from the same day from
 * disagreeing.
 *
 * Nothing here may fail the payee matching it runs alongside: `ensureDays` reports a failed run and
 * moves on, and a transaction whose days are missing simply gets no location yet.
 */
@Injectable()
export class OwnerLocationService {
  /** Days whose run failed since the last reset: not asked for again until then. */
  private readonly failed = new Set<string>();
  /** City fields whose batch failed since the last reset. */
  private readonly failedFields = new Set<string>();
  /** The whole of `place_field`, loaded on first use. This process is its only writer. */
  private places: Map<string, PlaceEntry> | null = null;

  /** Overridable clock, for tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly tracker: LocationService,
    private readonly resolver: DayLocationResolver,
    private readonly store: OwnerDayStore,
    private readonly replica: ReplicaDb,
    private readonly logger: StructuredLoggerService,
    private readonly placeResolver: PlaceFieldResolver,
    private readonly placeStore: PlaceFieldStore,
  ) {}

  /** `TX_LOCATION_ENABLED=false` turns every location step off. */
  get enabled(): boolean {
    return (process.env.TX_LOCATION_ENABLED ?? 'true') !== 'false';
  }

  /** Today's date where the owner is (UTC-6). */
  private today(): string {
    return new Date(this.now().getTime() + UTC_OFFSET_MS).toISOString().slice(0, 10);
  }

  /**
   * Forget which runs failed, so they are tried again. Called when the work queue drains.
   *
   * Without the memory, one run the resolver cannot answer would be re-asked by every transaction
   * whose window touches it — dozens of identical failing agent calls in a single sweep.
   */
  resetFailures(): void {
    this.failed.clear();
    this.failedFields.clear();
  }

  /**
   * Make sure each of `dates` has a current answer, resolving the ones that do not.
   *
   * A day needs resolving when it has never been resolved, or when its answer is provisional and
   * more than a day old. Those are grouped into runs of consecutive days and each run is one
   * resolver call, written as a whole.
   *
   * Never throws. A run that fails is logged and remembered, and the other runs still go ahead:
   * one stretch the resolver cannot answer must not hold up the rest of the year.
   */
  async ensureDays(dates: string[]): Promise<void> {
    const today = this.today();
    const wanted = [...new Set(dates)].filter((date) => date <= today).sort();
    try {
      const have = new Map((await this.store.get(wanted)).map((day) => [day.date, day]));
      const stale = wanted.filter((date) => this.needsResolving(have.get(date)));
      for (const run of consecutiveRuns(stale, MAX_RUN_DAYS)) {
        if (run.some((date) => this.failed.has(date))) {
          continue;
        }
        try {
          await this.resolveRun(run, today);
        } catch (error) {
          for (const date of run) {
            this.failed.add(date);
          }
          this.logger.warn(
            { error: error as Error, from: run[0], to: run.at(-1) },
            'could not resolve days; transactions in that stretch get no location until it succeeds',
          );
        }
      }
    } catch (error) {
      this.logger.warn({ error: error as Error }, 'could not read resolved days');
    }
  }

  private needsResolving(day: ResolvedDay | undefined): boolean {
    if (!day) {
      return true;
    }
    return (
      day.provisional && this.now().getTime() - Date.parse(day.resolvedAt) > PROVISIONAL_TTL_MS
    );
  }

  private async resolveRun(run: string[], today: string): Promise<void> {
    const range = evidenceRange(run, today);
    const tracker = await this.tracker.days(range.trackerDates);
    const evidence = buildDayEvidence(
      run,
      tracker,
      this.charges(range.chargesFrom, range.chargesTo),
      await this.store.get(range.trackerDates.filter((date) => !run.includes(date))),
    );
    const answers = checkDayAnswers(
      run,
      await this.resolver.resolve({ dates: run, evidence: evidence.text }),
    );
    await this.store.save(
      answers.map((answer) => ({
        date: answer.date,
        country: answer.country,
        location: answer.location,
        basis: answer.basis,
        confidence: answer.confidence,
        // Without the tracker the answer rests on charges alone, and is redone once it is back —
        // whatever the day's age.
        provisional: tracker === null || daysBetween(answer.date, today) < FINAL_AFTER_DAYS,
        data: { reason: answer.reason, ...evidence.perDay.get(answer.date)! },
      })),
    );
    this.logger.info(
      {
        from: run[0],
        to: run.at(-1),
        days: run.length,
        countries: [...new Set(answers.map((a) => a.country ?? 'unknown'))],
        // Without the tracker every day of the run is provisional.
        tracker: tracker !== null,
      },
      'resolved days',
    );
  }

  /** Card charges posted in a date range, with what is known of each payee. */
  private charges(from: string, to: string): Charge[] {
    return this.replica.db
      .select({
        date: bankTx.date,
        description: bankTx.description,
        amountCents: bankTx.amountCents,
        payeeName: payee.name,
        payeeKind: payee.locationKind,
        payeeCountry: payee.country,
      })
      .from(bankTx)
      .leftJoin(payee, eq(payee.id, bankTx.payeeId))
      .where(
        and(
          sql`${bankTx.date} >= ${from}`,
          sql`${bankTx.date} <= ${to}`,
          eq(bankTx.reconcile, false),
          isNull(bankTx.transferBankAccountId),
        ),
      )
      .orderBy(bankTx.date, bankTx.id)
      .all();
  }

  private async knownPlaces(): Promise<Map<string, PlaceEntry>> {
    this.places ??= new Map((await this.placeStore.all()).map((entry) => [entry.field, entry]));
    return this.places;
  }

  /**
   * Make sure the city field of each of `descriptions` has been worked out: "GUATE" is Guatemala
   * City, GT. Each distinct field is asked about once, ever, in batches; the answer may be "not a
   * place".
   *
   * This is what lets a purchase at a global chain be placed: its payee has no country, but the
   * description of each charge names the branch's town. Never throws, like ensureDays.
   */
  async ensurePlaces(descriptions: string[]): Promise<void> {
    try {
      const samples = new Map<string, Set<string>>();
      for (const description of descriptions) {
        const place = placeField(description);
        if (place?.shape === 'city') {
          const seen = samples.get(place.value) ?? new Set<string>();
          if (seen.size < MAX_PLACE_SAMPLES) {
            seen.add(description);
          }
          samples.set(place.value, seen);
        }
      }
      const known = await this.knownPlaces();
      const missing = [...samples.keys()].filter(
        (field) => !known.has(field) && !this.failedFields.has(field),
      );
      for (let i = 0; i < missing.length; i += MAX_PLACE_FIELDS) {
        const fields = missing.slice(i, i + MAX_PLACE_FIELDS);
        const request = fields.map((field) => ({ field, samples: [...samples.get(field)!] }));
        try {
          const answers = checkPlaceAnswers(
            fields,
            await this.placeResolver.resolve({ fields: request }),
          );
          await this.placeStore.save(
            answers.map((answer, n) => ({ ...answer, samples: request[n]!.samples })),
          );
          for (const answer of answers) {
            known.set(answer.field, answer);
          }
          this.logger.info(
            {
              fields: answers.length,
              places: answers.filter((a) => a.country !== null).length,
            },
            'resolved city fields',
          );
        } catch (error) {
          for (const field of fields) {
            this.failedFields.add(field);
          }
          this.logger.warn(
            { error: error as Error, fields },
            'could not resolve city fields; purchases naming them go by the payee or the posting lag',
          );
        }
      }
    } catch (error) {
      this.logger.warn({ error: error as Error }, 'could not read city fields');
    }
  }

  /** The country a description's own place field names, or null when it names none we know. */
  private async describedCountry(description: string): Promise<string | null> {
    const place = placeField(description);
    if (!place) {
      return null;
    }
    return place.shape === 'country'
      ? place.value
      : ((await this.knownPlaces()).get(place.value)?.country ?? null);
  }

  private async window(txDate: string): Promise<Map<string, ResolvedDay>> {
    const days = await this.store.get(windowDates(txDate, WINDOW_DAYS));
    return new Map(days.map((day) => [day.date, day]));
  }

  /**
   * Where the owner was when a transaction was bought. Reads resolved days and city fields only;
   * call `ensureDays` for the window and `ensurePlaces` for the description first.
   */
  async locate(
    tx: { date: string; description: string },
    payeePlace: PayeePlace | null,
  ): Promise<TxLocation> {
    return locateTx(
      tx.date,
      payeePlace,
      await this.window(tx.date),
      await this.describedCountry(tx.description),
    );
  }

  /**
   * The payee matcher's "where the owner was" block for a transaction dated `txDate`, or `null`
   * when location is off, unavailable, or says nothing about those days.
   */
  async describe(txDate: string): Promise<string | null> {
    if (!this.enabled) {
      return null;
    }
    try {
      await this.ensureDays(windowDates(txDate, WINDOW_DAYS));
      const days = await this.window(txDate);
      return formatOwnerWindow(txDate, days, locateTx(txDate, null, days));
    } catch (error) {
      this.logger.warn({ error: error as Error, txDate }, "no location for the matcher's prompt");
      return null;
    }
  }
}
