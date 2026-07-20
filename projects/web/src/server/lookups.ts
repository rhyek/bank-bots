import { createServerFn } from '@tanstack/react-start';
import { listCategoriesQuery, listPayeesQuery } from './queries/lookups';

export const listPayees = createServerFn().handler(() => listPayeesQuery());
export const listCategories = createServerFn().handler(() => listCategoriesQuery());
