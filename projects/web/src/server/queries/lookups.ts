import { and, asc, category, categoryGroup, db, eq, payee, sql, uuidv7 } from '@bank-bots/db';

export type PayeeOption = { id: string; name: string };
export type CategoryOption = { id: string; name: string; groupName: string };

export async function listPayeesQuery(): Promise<PayeeOption[]> {
  return db.select({ id: payee.id, name: payee.name }).from(payee).orderBy(asc(payee.name));
}

/**
 * Creates a payee and returns it, for the inline "Create <name>" in the payee picker.
 *
 * A payee with the same name (case-insensitively) is reused rather than duplicated — the picker
 * only offers "Create" when the typed text has no exact match, but this guards against a race or a
 * case-only difference producing two "Steam" rows. New ids are minted app-side with uuidv7, the
 * same way the AI matcher's create_payee tool and the schema's other tables do (payee.id has no DB
 * default; the YNAB-imported rows keep their original uuids).
 */
export async function createPayeeQuery(input: { name: string }): Promise<PayeeOption> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('Payee name cannot be empty');
  }

  const [existing] = await db
    .select({ id: payee.id, name: payee.name })
    .from(payee)
    .where(sql`lower(${payee.name}) = lower(${name})`)
    .limit(1);
  if (existing) {
    return existing;
  }

  const id = uuidv7();
  await db.insert(payee).values({ id, name });
  return { id, name };
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
