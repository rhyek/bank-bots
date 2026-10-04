import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { RawPoint } from '~/location/location-day';

const DEFAULT_URL = 'https://dawarich.homelab.rhyek.com';
const PER_PAGE = 1000;
const TIMEOUT_MS = 20_000;

/** The owner lives in Guatemala and travels to Costa Rica; both are UTC-6 with no DST. */
export const UTC_OFFSET = '-06:00';

const pointsSchema = z.array(
  z.object({
    country_name: z.string().nullish(),
    city: z.string().nullish(),
    latitude: z.union([z.string(), z.number()]).nullish(),
    longitude: z.union([z.string(), z.number()]).nullish(),
    topic: z.string().nullish(),
  }),
);

/** Read-only client for the owner's self-hosted Dawarich location history. */
@Injectable()
export class DawarichClient {
  private async page(
    params: Record<string, string>,
  ): Promise<{ points: z.infer<typeof pointsSchema>; pages: number }> {
    const url = new URL('/api/v1/points', process.env.DAWARICH_URL ?? DEFAULT_URL);
    url.search = new URLSearchParams({ order: 'desc', ...params }).toString();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.DAWARICH_API_KEY ?? ''}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Dawarich answered ${res.status} for ${url.pathname}`);
    }
    return {
      points: pointsSchema.parse(await res.json()),
      pages: Number(res.headers.get('x-total-pages') ?? 1),
    };
  }

  /**
   * Every point of one calendar day (UTC-6).
   *
   * Bounded on both sides on purpose: this takes ~0.3s, where a query with no lower bound ("the
   * last point at or before the end of the day") takes 6-7s on the same server. It also returns
   * every place visited, which the unbounded form cannot — a travel day has more than one.
   */
  async pointsForDay(date: string): Promise<RawPoint[]> {
    const range = {
      start_at: `${date}T00:00:00${UTC_OFFSET}`,
      end_at: `${date}T23:59:59${UTC_OFFSET}`,
      per_page: String(PER_PAGE),
    };
    const first = await this.page({ ...range, page: '1' });
    const points = [...first.points];
    for (let page = 2; page <= first.pages; page++) {
      points.push(...(await this.page({ ...range, page: String(page) })).points);
    }
    return points;
  }
}
