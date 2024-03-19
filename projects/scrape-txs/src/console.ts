import dayjs from 'dayjs';
import { program } from 'commander';
// import { updateYnab } from './lib/ynab';
import { configSchema } from './lib/config-schema';
import { bancoIndustrialScrape } from './lib/banco-industrial/scrape';
import { db } from './lib/db';

const { data: configJson } = await db
  .selectFrom('config')
  .select('data')
  .where('id', '=', 'general')
  .executeTakeFirstOrThrow();
const config = configSchema.parse(configJson);

program.option('-m, --month <months...>', 'Month(s) to scrape');

program.parse();

const options = program.opts<{
  month?: string[];
}>();

const months: dayjs.Dayjs[] = [];

if (options.month) {
  months.push(...options.month.map((month) => dayjs(month)));
} else {
  const today = dayjs(new Date());
  months.unshift(today);
  if (today.date() <= 10) {
    months.unshift(today.subtract(1, 'month'));
  }
}

await bancoIndustrialScrape({
  biConfig: config.banks.bancoIndustrialGt,
  months,
});

// // await updateYnab({
// //   ynabConfig: config.ynab,
// //   bankKey: 'bancoIndustrialGt',
// //   bankAccountsWithTransactions: biTransactions,
// //   dryRun: true,
// // });

await db.destroy();
