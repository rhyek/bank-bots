import { and, asc, category, categoryGroup, db, eq, payee } from '@bank-bots/db';

export type PayeeOption = { id: string; name: string };
export type CategoryOption = { id: string; name: string; groupName: string };

export async function listPayeesQuery(): Promise<PayeeOption[]> {
  return db.select({ id: payee.id, name: payee.name }).from(payee).orderBy(asc(payee.name));
}

/**
 * Categories for the picker, grouped.
 *
 * Hidden categories and hidden groups are excluded — in YNAB those are the archive, not choices a
 * user should be able to assign to a new transaction.
 */
export async function listCategoriesQuery(): Promise<CategoryOption[]> {
  return db
    .select({ id: category.id, name: category.name, groupName: categoryGroup.name })
    .from(category)
    .innerJoin(categoryGroup, eq(category.groupId, categoryGroup.id))
    .where(and(eq(category.hidden, false), eq(categoryGroup.hidden, false)))
    .orderBy(asc(categoryGroup.name), asc(category.name));
}
