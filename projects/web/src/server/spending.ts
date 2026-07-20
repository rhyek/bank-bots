import { createServerFn } from '@tanstack/react-start';
import {
  listBucketTransactionsQuery,
  monthSummaryQuery,
  type SpendingBucket,
} from './queries/spending';

export const monthSummary = createServerFn()
  .validator((input: { month: string }) => input)
  .handler(({ data }) => monthSummaryQuery(data));

export const listBucketTransactions = createServerFn()
  .validator((input: { month: string; bucket: SpendingBucket }) => input)
  .handler(({ data }) => listBucketTransactionsQuery(data));
