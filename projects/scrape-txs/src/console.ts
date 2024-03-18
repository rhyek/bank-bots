import path from 'node:path';
import dayjs, { Dayjs } from 'dayjs';
import { program } from 'commander';
// import { updateYnab } from './lib/ynab';
import { configSchema } from './lib/config-schema';
import { bancoIndustrialScrape } from './lib/banco-industrial/scrape';

const config = configSchema.parse(
  await Bun.file(path.resolve(__dirname, '../config.json')).json()
);

program.option('-m, --month <months...>', 'Month(s) to scrape');

program.parse();

const options = program.opts<{
  month?: string[];
}>();

const months: Dayjs[] = [];

if (options.month) {
  months.push(...options.month.map((month) => dayjs(month)));
} else {
  const today = dayjs(new Date());
  months.unshift(today);
  if (today.date() <= 10) {
    months.unshift(today.subtract(1, 'month'));
  }
}

// // console.log('config', config);

await bancoIndustrialScrape({
  biConfig: config.banks.bancoIndustrialGt,
  months,
});

// await updateYnab({
//   ynabConfig: config.ynab,
//   bankKey: 'bancoIndustrialGt',
//   bankAccountsWithTransactions: biTransactions,
//   dryRun: true,
// });
