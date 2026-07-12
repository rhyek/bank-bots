import { program } from 'commander';
import dayjs from 'dayjs';
import { mailer } from './lib/mail';
import { run } from './lib/run';

program.option('-m, --month <months...>', 'Month(s) to scrape');
program.option(
  '-b, --bank-key <bankKey>',
  'Bank key to scrape; takes priority over the BANK_KEY env var',
);
program.option(
  '-t, --trace-dir <dir>',
  'Directory to save the Playwright trace into on failure (default: storage/playwright-traces)',
);

program.parse();

const options = program.opts<{
  month?: string[];
  bankKey?: string;
  traceDir?: string;
}>();

const bankKey = options.bankKey ?? process.env.BANK_KEY;

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

try {
  await run(months, bankKey, options.traceDir);
} catch (error) {
  console.error(error);
  const emailSubject = `Scrape bank txs failed for ${bankKey}`;
  const emailBody = `Error:\n${(error as Error).message}`;
  await mailer.sendMail({
    to: process.env.MAILER_ME,
    subject: emailSubject,
    text: emailBody,
  });
  process.exitCode = 1;
}
