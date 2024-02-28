import path from 'node:path';
import dayjs from 'dayjs';
import { getBancoIndustrialTransactions } from './lib/banco-industrial';
import { updateYnab } from './lib/ynab';
import { configSchema } from './lib/config';

const config = configSchema.parse(
  await Bun.file(path.resolve(__dirname, '../config.json')).json()
);

const today = dayjs(new Date());
const months = [today];
if (today.date() <= 10) {
  months.unshift(today.subtract(1, 'month'));
}

const biTransactions = await getBancoIndustrialTransactions({
  biConfig: config.banks.bancoIndustrialGt,
  months,
  real: true,
});

await updateYnab({
  ynabConfig: config.ynab,
  bankKey: 'bancoIndustrialGt',
  bankAccountsWithTransactions: biTransactions,
});
