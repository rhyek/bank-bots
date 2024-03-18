import type { ScheduledHandler } from 'aws-lambda';
import { bancoIndustrialScrape } from './lib/banco-industrial/scrape';

export const handler: ScheduledHandler = async (_event) => {
  console.log('hi');
  await bancoIndustrialScrape({
    // biConfig: config.banks.bancoIndustrialGt,
    // months,
  } as any);
};
