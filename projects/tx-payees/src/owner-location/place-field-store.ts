import { Injectable } from '@nestjs/common';
import { placeField, db as pgDb } from '@bank-bots/db';
import type { PlaceEntry } from '~/owner-location/place-resolver';

/** `place_field`, read and written directly in Postgres. Like owner_day_location, not replicated. */
@Injectable()
export class PlaceFieldStore {
  async all(): Promise<PlaceEntry[]> {
    return pgDb
      .select({ field: placeField.field, country: placeField.country, place: placeField.place })
      .from(placeField);
  }

  async save(entries: (PlaceEntry & { samples: string[] })[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await pgDb
      .insert(placeField)
      .values(
        entries.map((entry) => ({
          field: entry.field,
          country: entry.country,
          place: entry.place,
          data: { samples: entry.samples },
        })),
      )
      .onConflictDoNothing();
  }
}
