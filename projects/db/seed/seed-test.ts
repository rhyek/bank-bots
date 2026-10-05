// Writes the rows in ./test-data.ts into the TEST database.
//
// devtooie runs it from the `db` service's `afterReady` when the database is `fresh`
// (devtooie.config.ts): the first time the service starts, and after a destroy or
//   pnpm devtooie --mode test infra up --reset db
// which is the way to get these rows back once something has changed them.
//
// It only adds rows, and it expects the database the migrations have just built. Run against one
// that already holds the seed it fails on the first duplicate key, having written nothing.
import {
  assertSeedFacts,
  accounts,
  categories,
  categoryGroups,
  payees,
  transactions,
} from './test-data';

// Invented transactions have no business anywhere else: only test mode, only a local database.
const url = new URL(process.env.DATABASE_URL ?? 'postgres://unset');
if (process.env.DEVTOOIE_MODE !== 'test' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
  throw new Error(
    `refusing to seed: these are invented rows, for test mode and a local database only ` +
      `(DEVTOOIE_MODE=${process.env.DEVTOOIE_MODE ?? 'unset'}, database host ${url.hostname}).`,
  );
}

// Before any write: a seed that contradicts its own documented figures must not reach the database.
assertSeedFacts();

// Imported only now, after the guard: the module opens its connection pool on DATABASE_URL at load.
const { bankAccount, bankTx, category, categoryGroup, db, payee, pool, sql } =
  await import('../src/index');

// One transaction: the seed is either all there or not at all.
await db.transaction(async (trx) => {
  // The four accounts migration 0003 inserted are already here, under the same ids, with only
  // their bank key, number and type set. Fill the rest in; the fifth account is new.
  await trx
    .insert(bankAccount)
    .values([...accounts])
    .onConflictDoUpdate({
      target: bankAccount.id,
      set: {
        type: sql`excluded.type`,
        currency: sql`excluded.currency`,
        name: sql`excluded.name`,
        runningBalanceCents: sql`excluded.running_balance_cents`,
      },
    });
  await trx.insert(categoryGroup).values(categoryGroups);
  await trx.insert(category).values(categories);
  await trx.insert(payee).values(payees);
  await trx.insert(bankTx).values(transactions);
});

console.log(
  `seeded: ${accounts.length} accounts, ${categories.length} categories in ${categoryGroups.length} ` +
    `groups, ${payees.length} payees, ${transactions.length} transactions`,
);
await pool.end();
