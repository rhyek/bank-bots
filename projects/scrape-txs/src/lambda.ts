import type { ScheduledHandler } from 'aws-lambda';
import dayjs from 'dayjs';
import { run } from './lib/run';

export const handler: ScheduledHandler = async (_event) => {
  const months: dayjs.Dayjs[] = [];
  const today = dayjs(new Date());
  months.unshift(today);
  if (today.date() <= 10) {
    months.unshift(today.subtract(1, 'month'));
  }
  await run(months);
};
