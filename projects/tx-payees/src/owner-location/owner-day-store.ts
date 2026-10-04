import { Injectable } from '@nestjs/common';
import { ownerDayLocation, db as pgDb, inArray as pgInArray } from '@bank-bots/db';
import type {
  Basis,
  Confidence,
  ResolvedDay,
  ResolvedDayWrite,
} from '~/owner-location/resolved-day';

/**
 * `owner_day_location`, read and written directly in Postgres.
 *
 * It is not replicated to SQLite: nothing but the owner-location module uses it, and a replica that
 * is dropped on every schema bump is the wrong home for answers that each cost an agent call.
 */
@Injectable()
export class OwnerDayStore {
  async get(dates: string[]): Promise<ResolvedDay[]> {
    if (dates.length === 0) {
      return [];
    }
    const rows = await pgDb
      .select()
      .from(ownerDayLocation)
      .where(pgInArray(ownerDayLocation.date, dates));
    return rows.map((row) => ({
      date: row.date,
      country: row.country,
      location: row.location,
      basis: row.basis as Basis,
      confidence: row.confidence as Confidence,
      provisional: row.provisional,
      resolvedAt: row.updatedAt,
    }));
  }

  /** Write one run's days together: a run is resolved as a whole or not at all. */
  async save(days: ResolvedDayWrite[]): Promise<void> {
    await pgDb.transaction(async (tx) => {
      for (const day of days) {
        const values = {
          country: day.country,
          location: day.location,
          basis: day.basis,
          confidence: day.confidence,
          provisional: day.provisional,
          data: day.data,
        };
        await tx
          .insert(ownerDayLocation)
          .values({ date: day.date, ...values })
          .onConflictDoUpdate({ target: ownerDayLocation.date, set: values });
      }
    });
  }
}
