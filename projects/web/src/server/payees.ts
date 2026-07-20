import { createServerFn } from '@tanstack/react-start';
import { listPayeeSummariesQuery, unmatchedCountQuery } from './queries/payees';

export const listPayeeSummaries = createServerFn().handler(() => listPayeeSummariesQuery());
export const unmatchedCount = createServerFn().handler(() => unmatchedCountQuery());
