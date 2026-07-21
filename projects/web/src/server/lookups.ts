import { createServerFn } from '@tanstack/react-start';
import { createPayeeQuery, listCategoriesQuery, listPayeesQuery } from './queries/lookups';

export const listPayees = createServerFn().handler(() => listPayeesQuery());
export const listCategories = createServerFn().handler(() => listCategoriesQuery());

export const createPayee = createServerFn({ method: 'POST' })
  .validator((input: { name: string }) => input)
  .handler(({ data }) => createPayeeQuery(data));
