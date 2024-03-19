import type { ScheduledHandler } from 'aws-lambda';
import dayjs, { type Dayjs } from 'dayjs';
import { bancoIndustrialScrape } from './lib/banco-industrial/scrape';
import { db } from './lib/db';
import { configSchema } from './lib/config-schema';

export const handler: ScheduledHandler = async (_event) => {
  const months: Dayjs[] = [];
  const today = dayjs(new Date());
  months.unshift(today);
  if (today.date() <= 10) {
    months.unshift(today.subtract(1, 'month'));
  }
  const { data: configJson } = await db
    .selectFrom('config')
    .select('data')
    .where('id', '=', 'general')
    .executeTakeFirstOrThrow();
  const config = configSchema.parse(configJson);
  await bancoIndustrialScrape({
    biConfig: config.banks.bancoIndustrialGt,
    months,
    isLambda: true,
  });
  await db.destroy();
};
