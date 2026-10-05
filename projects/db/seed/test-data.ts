// The test database's contents: what `seed-test.ts` writes into a database the migrations have
// just built.
//
// It is a small, invented household ledger built around the cases the web app's query tests cover.
// The figures those tests assert are stated in SEED_FACTS below and checked by `assertSeedFacts`
// every time the seed runs — so a row edited here without its fact (or the other way round) fails
// the seed loudly instead of failing a test somewhere else with a number nobody can trace.
//
// What each part is for:
//   - January 2026 is the spending fixture: every row categorized, one refund that nets a category
//     positive, income in YNAB's hidden internal group, and a transfer pair that must be excluded.
//   - May 2026 carries two uncategorized self-transfers that are NOT marked as transfers, which is
//     the state the real data is in and the reason the "uncategorized" bucket exists.
//   - February to April are filler with the same shape, so the list has more than one page of 50.
//   - 2019-01 has nothing, on purpose (the "empty month" test).

const uuid = (kind: number, n: number) =>
  `00000000-0000-7000-8${String(kind).padStart(3, '0')}-${String(n).padStart(12, '0')}`;

// The five accounts the scraper is configured for, by their real bank keys and numbers.
//
// Four of them already exist in a database the migrations have just built: 0003_finalize_bank_tx
// inserts them, with these literal ids. The seed keeps those ids and only fills in the columns the
// migration leaves empty; the savings account is the one row it adds.
export const accounts = [
  {
    id: '019f631c-aa0b-7493-af88-944bbb5453db',
    bankKey: 'bacGt',
    accountNumber: '904201043',
    type: 'checking',
    currency: 'USD',
    name: null,
    // Deliberately NOT the sum of this account's rows: the balance the app shows is
    // SUM(amount_cents), and a test proves it by this number being wrong.
    runningBalanceCents: 100,
  },
  {
    id: '019f631c-aa0b-7493-af88-9acf976e9040',
    bankKey: 'bacGt',
    accountNumber: 'CR07010200009697902868',
    type: 'checking',
    currency: 'USD',
    name: null,
    runningBalanceCents: null,
  },
  {
    id: '019f631c-aa0a-777d-b714-4eebf86a8e2f',
    bankKey: 'bacCr',
    accountNumber: 'CR93010200009615666272',
    type: 'checking',
    currency: 'USD',
    name: 'BAC Costa Rica',
    runningBalanceCents: null,
  },
  {
    id: '019f631c-aa0b-7493-af88-9ef583b47786',
    bankKey: 'bancoIndustrialGt',
    accountNumber: '3250099185',
    type: 'checking',
    currency: 'USD',
    name: 'BI Monetaria',
    runningBalanceCents: null,
  },
  {
    id: uuid(1, 5),
    bankKey: 'bancoIndustrialGt',
    accountNumber: '3388707',
    type: 'savings',
    currency: 'USD',
    name: 'BI Ahorros',
    runningBalanceCents: null,
  },
] as const;

const [MAIN, BAC_GT_2, BAC_CR, BI_CHECKING, BI_SAVINGS] = accounts;

// Group and category names are the ones the tests look up. `Internal Master Category` is YNAB's
// own bookkeeping group, which the spending page hides by that exact name.
const groupNames = [
  'Internal Master Category',
  'Fixed',
  'Variable',
  'Non-Monthly',
  'Required Variable',
  'Health',
  'Quality of Life',
] as const;
type GroupName = (typeof groupNames)[number];

export const categoryGroups = groupNames.map((name, i) => ({ id: uuid(2, i + 1), name }));

const categoryNames = {
  'Inflow: Ready to Assign': 'Internal Master Category',
  Uncategorized: 'Internal Master Category',
  Rent: 'Fixed',
  'Car Loan': 'Fixed',
  Insurance: 'Fixed',
  Electricity: 'Fixed',
  Groceries: 'Variable',
  'Dining Out': 'Variable',
  Miscellaneous: 'Variable',
  'Car Maintenance': 'Non-Monthly',
  Gas: 'Required Variable',
  Pharmacy: 'Health',
  'Vegas 2025': 'Quality of Life',
} as const satisfies Record<string, GroupName>;
type CategoryName = keyof typeof categoryNames;

export const categories = Object.entries(categoryNames).map(([name, group], i) => ({
  id: uuid(3, i + 1),
  name,
  groupId: categoryGroups.find((g) => g.name === group)!.id,
}));

const payeeNames = [
  'Acme Corp',
  'Inmobiliaria Las Flores',
  'Banco Automotriz',
  'Seguros El Roble',
  'Eegsa',
  'La Torre',
  'Walmart',
  'Pollo Campero',
  "McDonald's",
  'Amazon',
  'Spotify',
  'Uber',
  'Shell',
  'Puma',
  'Farmacia Galeno',
  'Taller Mecánico Central',
  'MGM Resorts',
] as const;
type PayeeName = (typeof payeeNames)[number];

export const payees = payeeNames.map((name, i) => ({ id: uuid(4, i + 1), name }));

type Account = (typeof accounts)[number];

interface TxInput {
  date: string;
  account?: Account;
  description: string;
  amountCents: number;
  payee?: PayeeName;
  category?: CategoryName;
  /** The other account of a transfer that IS marked as one. */
  transferTo?: Account;
  reconcile?: boolean;
}

const inputs: TxInput[] = [];
const tx = (
  date: string,
  description: string,
  amountCents: number,
  payee?: PayeeName,
  category?: CategoryName,
  extra: Partial<TxInput> = {},
) => inputs.push({ date, description, amountCents, payee, category, ...extra });

const INCOME = 'Inflow: Ready to Assign';
const SALARY = 554157;

// --- December 2025: where the main account's balance starts -----------------------------------
tx('2025-12-31', 'SALDO INICIAL', 981022, undefined, undefined, { reconcile: true });

// --- January 2026: the spending fixture --------------------------------------------------------
tx('2026-01-02', 'INMOBILIARIA LAS FLORES RENTA', -200000, 'Inmobiliaria Las Flores', 'Rent');
tx('2026-01-03', 'LA TORRE ZONA 14         GUATE', -18450, 'La Torre', 'Groceries');
tx('2026-01-05', 'BANCO AUTOMOTRIZ CUOTA 14/48', -150000, 'Banco Automotriz', 'Car Loan');
tx('2026-01-06', 'SHELL LAS AMERICAS       GUATE', -12081, 'Shell', 'Gas');
tx('2026-01-08', 'SEGUROS EL ROBLE POLIZA', -51228, 'Seguros El Roble', 'Insurance');
tx('2026-01-09', 'POLLO CAMPERO OAKLAND    GUATE', -12500, 'Pollo Campero', 'Dining Out');
tx('2026-01-10', 'LA TORRE ZONA 14         GUATE', -22310, 'La Torre', 'Groceries');
tx('2026-01-11', 'AMAZON.COM MKTPL          US', -30000, 'Amazon', 'Miscellaneous');
// The refund: money IN, in a spending category. It nets `Vegas 2025` to +100.00 and is also part
// of the month's gross inflow.
tx('2026-01-12', 'MGM RESORTS REFUND        US', 10000, 'MGM Resorts', 'Vegas 2025');
tx('2026-01-14', 'SPOTIFY                   US', -1099, 'Spotify', 'Miscellaneous');
tx('2026-01-15', 'PAGO PLANILLA ACME CORP', SALARY, 'Acme Corp', INCOME);
// A transfer that IS marked as one, both legs. Excluded from every spending figure; if that
// filter broke, January's inflow and outflow would both be off by 3000.00.
tx('2026-01-16', 'TRANSF. PROPIA 3388707', -300000, undefined, undefined, {
  transferTo: BI_SAVINGS,
});
tx('2026-01-16', 'TRANSF. PROPIA 904201043', 300000, undefined, undefined, {
  account: BI_SAVINGS,
  transferTo: MAIN,
});
tx('2026-01-17', 'MCDONALDS PRADERA        GUATE', -9814, "McDonald's", 'Dining Out');
tx('2026-01-18', 'FARMACIA GALENO Z10      GUATE', -14484, 'Farmacia Galeno', 'Pharmacy');
tx('2026-01-20', 'EEGSA PAGO SERVICIO', -45230, 'Eegsa', 'Electricity');
tx('2026-01-21', 'PUMA VISTA HERMOSA       GUATE', -8500, 'Puma', 'Gas');
tx(
  '2026-01-22',
  'TALLER MECANICO CENTRAL  GUATE',
  -25749,
  'Taller Mecánico Central',
  'Car Maintenance',
);
tx('2026-01-24', 'WALMART ROOSEVELT        GUATE', -21550, 'Walmart', 'Groceries');
tx('2026-01-25', 'POLLO CAMPERO OAKLAND    GUATE', -15800, 'Pollo Campero', 'Dining Out');
tx('2026-01-27', 'AMAZON.COM MKTPL          US', -16901, 'Amazon', 'Miscellaneous');
tx('2026-01-30', 'PAGO PLANILLA ACME CORP', SALARY, 'Acme Corp', INCOME);

// --- February to April 2026: filler, the same household -----------------------------------------
const filler: [month: string, groceries: [number, number], dining: number, gas: number][] = [
  ['2026-02', [19875, 23140], 11250, 9900],
  ['2026-03', [21030, 17990], 14400, 10350],
  ['2026-04', [20500, 24615], 9980, 11200],
];
for (const [month, [groceriesA, groceriesB], dining, gas] of filler) {
  tx(`${month}-02`, 'INMOBILIARIA LAS FLORES RENTA', -200000, 'Inmobiliaria Las Flores', 'Rent');
  tx(`${month}-05`, 'BANCO AUTOMOTRIZ CUOTA', -150000, 'Banco Automotriz', 'Car Loan');
  tx(`${month}-07`, 'LA TORRE ZONA 14         GUATE', -groceriesA, 'La Torre', 'Groceries');
  tx(`${month}-13`, 'POLLO CAMPERO OAKLAND    GUATE', -dining, 'Pollo Campero', 'Dining Out');
  tx(`${month}-15`, 'PAGO PLANILLA ACME CORP', SALARY, 'Acme Corp', INCOME);
  tx(`${month}-19`, 'SHELL LAS AMERICAS       GUATE', -gas, 'Shell', 'Gas');
  tx(`${month}-23`, 'WALMART ROOSEVELT        GUATE', -groceriesB, 'Walmart', 'Groceries');
  tx(`${month}-28`, 'PAGO PLANILLA ACME CORP', SALARY, 'Acme Corp', INCOME);
}
// Rows on the other accounts, so "one account" is a real filter.
tx('2026-03-10', 'UBER TRIP                 CR', -4500, 'Uber', 'Miscellaneous', {
  account: BAC_CR,
});
tx('2026-03-12', 'AUTO MERCADO ESCAZU      SAN J', -8900, undefined, 'Groceries', {
  account: BAC_CR,
});
tx('2026-04-02', 'DEPOSITO EN EFECTIVO', 100000, undefined, INCOME, { account: BAC_GT_2 });
// A charge nobody has matched yet: no payee, no category.
tx('2026-04-21', 'COMPRA POS 4471          GUATE', -5300);

// --- May 2026: the uncategorized month ---------------------------------------------------------
tx('2026-05-02', 'INMOBILIARIA LAS FLORES RENTA', -200000, 'Inmobiliaria Las Flores', 'Rent');
// A self-transfer the way the real data has them: both legs present, neither marked as a transfer
// nor categorized. They land in the "uncategorized" bucket and in the month's gross totals.
tx('2026-05-04', 'TRANSFERENCIA A CUENTA 3250099185', -500000);
tx('2026-05-04', 'TRANSFERENCIA DE CUENTA 904201043', 500000, undefined, undefined, {
  account: BI_CHECKING,
});
tx('2026-05-09', 'LA TORRE ZONA 14         GUATE', -20100, 'La Torre', 'Groceries');
tx('2026-05-15', 'PAGO PLANILLA ACME CORP', SALARY, 'Acme Corp', INCOME);
tx('2026-05-20', 'EEGSA PAGO SERVICIO', -39800, 'Eegsa', 'Electricity');
tx('2026-05-29', 'PAGO PLANILLA ACME CORP', SALARY, 'Acme Corp', INCOME);

const idOf = <T extends { id: string; name: string }>(rows: readonly T[], name?: string) =>
  name === undefined ? null : rows.find((row) => row.name === name)!.id;

export const transactions = inputs.map((input, i) => ({
  id: uuid(5, i + 1),
  bankAccountId: (input.account ?? MAIN).id,
  month: input.date.slice(0, 7),
  date: input.date,
  docNo: `SEED${String(i + 1).padStart(4, '0')}`,
  description: input.description,
  amountCents: input.amountCents,
  payeeId: idOf(payees, input.payee),
  categoryId: idOf(categories, input.category),
  transferBankAccountId: input.transferTo?.id ?? null,
  reconcile: input.reconcile ?? false,
}));

/** What the web app's query tests assert about this data. Change a row, change its fact. */
export const SEED_FACTS = {
  /** More than one page of 50 for the transactions list. */
  minimumTransactions: 51,
  /** SUM(amount_cents) of bacGt 904201043, every row included. */
  mainAccountBalanceCents: 3567466,
  january2026: {
    inflowCents: 1118314,
    outflowCents: 655696,
    groupNetCents: {
      Fixed: -446458,
      Variable: -148424,
      'Non-Monthly': -25749,
      'Required Variable': -20581,
      Health: -14484,
      'Quality of Life': 10000,
    },
  },
} as const;

/** Recomputes SEED_FACTS from the rows above, the way the app counts them, and throws on a gap. */
export function assertSeedFacts(): void {
  const problems: string[] = [];
  const check = (what: string, actual: number, expected: number) => {
    if (actual !== expected) {
      problems.push(`${what}: the rows give ${actual}, SEED_FACTS says ${expected}`);
    }
  };
  const sum = (rows: { amountCents: number }[]) => rows.reduce((n, r) => n + r.amountCents, 0);

  if (transactions.length < SEED_FACTS.minimumTransactions) {
    problems.push(`only ${transactions.length} transactions; the list tests need a second page`);
  }
  check(
    'main account balance',
    sum(transactions.filter((t) => t.bankAccountId === MAIN.id)),
    SEED_FACTS.mainAccountBalanceCents,
  );

  // A month's spending leaves out rows marked as transfers, exactly like the app's query.
  const january = transactions.filter(
    (t) => t.month === '2026-01' && t.transferBankAccountId === null,
  );
  const facts = SEED_FACTS.january2026;
  check('January inflow', sum(january.filter((t) => t.amountCents > 0)), facts.inflowCents);
  check('January outflow', -sum(january.filter((t) => t.amountCents < 0)), facts.outflowCents);
  for (const [group, expected] of Object.entries(facts.groupNetCents)) {
    const groupId = categoryGroups.find((g) => g.name === group)!.id;
    const categoryIds = new Set(categories.filter((c) => c.groupId === groupId).map((c) => c.id));
    check(
      `January net of group "${group}"`,
      sum(january.filter((t) => t.categoryId !== null && categoryIds.has(t.categoryId))),
      expected,
    );
  }
  if (january.some((t) => t.categoryId === null)) {
    problems.push(
      'January has an uncategorized row; the spending fixture needs every row categorized',
    );
  }

  if (problems.length > 0) {
    throw new Error(`the test seed no longer matches its facts:\n  ${problems.join('\n  ')}`);
  }
}
