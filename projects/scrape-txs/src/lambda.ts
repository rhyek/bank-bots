import type { ScheduledHandler } from 'aws-lambda';
import dayjs from 'dayjs';
import { run } from './lib/run';
import { mailer } from './lib/mail';

export const handler: ScheduledHandler = async (_event) => {
  const months: dayjs.Dayjs[] = [];
  const today = dayjs(new Date());
  months.unshift(today);
  if (today.date() <= 10) {
    months.unshift(today.subtract(1, 'month'));
  }
  try {
    await run(months);
  } catch (error: any) {
    console.error(error);
    const emailSubject = `Scrape bank txs failed for ${process.env.BANK_KEY}`;
    const emailBody = `Error:\n${error.message}`;
    await mailer.sendMail({
      to: process.env.MAILER_ME,
      subject: emailSubject,
      text: emailBody,
    });
  }
};
