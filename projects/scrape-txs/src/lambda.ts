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
    const emailSubject = `Scrape bank txs failed`;
    const emailBody = `Error:
${error.stack}
`;
    await mailer.sendMail({
      to: process.env.MAILER_ME,
      subject: emailSubject,
      text: emailBody,
    });
  }
};
