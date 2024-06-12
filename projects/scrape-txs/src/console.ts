import { program } from 'commander';
import dayjs from 'dayjs';
import { run } from './lib/run';

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

await run(months);
