// Value import (not `import type`): the savings statement below has to compare the requested month
// against the real clock, because Bi en Línea only exposes "current" and "previous" month.
import dayjs from 'dayjs';
import type { Page } from 'playwright';
import { isMatching } from 'ts-pattern';
import { AccountType } from '../types';
import { db, type bankTx } from '@bank-bots/db';
import { ensureBankAccount } from '../bank-accounts';
import { waitRandomMs } from '../utils';

export type BiConfig = {
  auth: {
    code: string;
    username: string;
    password: string;
  };
  accounts: {
    type: AccountType;
    number: string;
  }[];
};

export async function bancoIndustrialScrape({
  bankKey,
  biConfig: { auth, accounts },
  months,
  page,
}: {
  bankKey: string;
  biConfig: BiConfig;
  months: dayjs.Dayjs[];
  page: Page;
}) {
  console.log(
    `Scraping Banco Industrial GT transactions for months: ${months
      .map((m) => m.format('YYYY-MM'))
      .join(', ')}`,
  );
  await page.goto('https://www.bienlinea.bi.com.gt/InicioSesion/Inicio/Autenticar');
  await page.getByRole('textbox', { name: 'Código' }).fill(auth.code);
  await waitRandomMs();
  await page.getByRole('textbox', { name: 'Usuario' }).fill(auth.username);
  await waitRandomMs();
  await page.getByPlaceholder('Contraseña').fill(auth.password);
  await waitRandomMs();
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();

  await page.waitForURL('https://www.bienlinea.bi.com.gt/InicioSesion/Token/BienvenidoDashBoard');
  const createTxs: (typeof bankTx.$inferInsert)[] = [];
  const deleteTxIds: string[] = [];
  for (const account of accounts) {
    const bankAccountId = await ensureBankAccount({
      bankKey,
      accountNumber: account.number,
      type: account.type,
    });
    for (const monthDayJs of months) {
      const currentTxs = await db.query.bankTx.findMany({
        where: (t, { and, eq }) =>
          and(eq(t.bankAccountId, bankAccountId), eq(t.month, monthDayJs.format('YYYY-MM'))),
      });
      const rawTransactions = await getAccountTransactions(
        page,
        account.type,
        account.number,
        monthDayJs,
      );
      // `null` means the bank cannot serve this account/month at all (see
      // getSavingsAccountTransactions). Skip it entirely rather than falling through with an empty
      // list: the delete pass below reads "nothing scraped" as "the bank no longer has these rows"
      // and would wipe the month's stored history.
      if (rawTransactions === null) {
        continue;
      }
      const _bankTxs: (typeof bankTx.$inferInsert)[] = rawTransactions.map((tx) => {
        const [_, dateStr] = tx.date.match(DAY_MONTH)!;
        const amountCents =
          tx.credit && tx.credit !== ''
            ? Math.round(Number(tx.credit) * 100)
            : -Math.round(Number(tx.debit) * 100);
        return {
          bankAccountId,
          month: monthDayJs.format('YYYY-MM'),
          date: monthDayJs.date(Number(dateStr)).format('YYYY-MM-DD'),
          description: tx.description,
          docNo: tx.docNo,
          amountCents,
        };
      });
      const _deleteTxIds = currentTxs
        .filter((currentTx) => {
          // Never delete manual reconciliation rows — they aren't on the bank statement, so the
          // scrape would otherwise wipe them (and un-reconcile the account) on every run.
          if (currentTx.reconcile) {
            return false;
          }
          const objToMatch = {
            bankAccountId: currentTx.bankAccountId,
            date: currentTx.date,
            docNo: currentTx.docNo,
            description: currentTx.description,
            amountCents: currentTx.amountCents,
          };
          return !_bankTxs.some((scrapedTx) => isMatching(objToMatch, scrapedTx));
        })
        .map((tx) => tx.id);
      createTxs.push(..._bankTxs);
      deleteTxIds.push(..._deleteTxIds);
    }
  }
  return { createTxs, deleteTxIds };
}

/**
 * `DD - MM` on the monetary statement, `DD-MM` on the savings one — the separator's spacing is the
 * only difference, so `\s*` covers both. Group 1 is the day; the month is checked separately.
 */
const DAY_MONTH = /(\d{2})\s*-\s*(\d{2})/;

/**
 * A statement row, in the shape both account types produce.
 *
 * The two statements share their first six columns exactly (date, type, description, doc no, debit,
 * credit); savings adds a running-balance column that nothing here needs.
 */
type RawTx = {
  date: string;
  type: string;
  description: string;
  docNo: string;
  debit: string;
  credit: string;
};

/** Resolves to `null` when the bank cannot serve this account/month — see the caller. */
function getAccountTransactions(
  page: Page,
  accountType: AccountType,
  accountNumber: string,
  monthDayJs: dayjs.Dayjs,
): Promise<RawTx[] | null> {
  switch (accountType) {
    case AccountType.Checking:
      return getMonetaryAccountTransactions(page, accountNumber, monthDayJs);
    case AccountType.Savings:
      return getSavingsAccountTransactions(page, accountNumber, monthDayJs);
    default: {
      // Exhaustive: a new AccountType fails the build here rather than being skipped in silence,
      // which is what the old `if (type === 'checking')` did — a scrape would exit 0 having
      // imported nothing.
      const unreachable: never = accountType;
      throw new Error(`Unsupported Banco Industrial account type: ${String(unreachable)}`);
    }
  }
}

/** Scrapes the rows out of whichever statement page is currently open. */
function readStatementRows(page: Page): Promise<RawTx[]> {
  // A month with no movements renders NO table at all — just a "La cuenta no posee movimientos"
  // notice — so an absent `.tbl-report` is a legitimate empty result, not a broken selector.
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tbl-report tbody tr')).map((tr) => ({
      date: tr.querySelector('td:nth-child(1)')!.textContent!.trim(),
      type: tr.querySelector('td:nth-child(2)')!.textContent!.trim(),
      description: tr.querySelector('td:nth-child(3)')!.textContent!.trim(),
      docNo: tr.querySelector('td:nth-child(4)')!.textContent!.trim(),
      debit: tr.querySelector('td:nth-child(5)')!.textContent!.trim().replace(/,/g, ''),
      credit: tr.querySelector('td:nth-child(6)')!.textContent!.trim().replace(/,/g, ''),
    }));
  });
}

/**
 * Savings ("Ahorros") statements.
 *
 * Bi en Línea publishes these only as ACTUAL (current calendar month) and ANTERIOR (the one before)
 * — its PERSONALIZADO form looks like a free date range but its month selector offers exactly those
 * two values, and the date inputs only narrow *within* the selected one. Asking it for an older
 * range returns "La cuenta no posee movimientos" rather than an error.
 *
 * An unreachable month resolves to `null`, never `[]`, because the caller reads an empty list as
 * "the bank no longer has these rows" and deletes the month's stored history.
 *
 * It is `null` rather than a thrown error so that backfilling the CHECKING account still works:
 * checking statements do support arbitrary ranges, and a throw here would abort the whole bank's
 * scrape (and fire its failure alert) just because savings couldn't serve the same old month.
 */
async function getSavingsAccountTransactions(
  page: Page,
  accountNumber: string,
  monthDayJs: dayjs.Dayjs,
): Promise<RawTx[] | null> {
  const target = monthDayJs.format('YYYY-MM');
  const now = dayjs();
  const statement =
    target === now.format('YYYY-MM')
      ? { link: 'ACTUAL', path: 'EstadoCuentaAhorroActual' }
      : target === now.subtract(1, 'month').format('YYYY-MM')
        ? { link: 'ANTERIOR', path: 'EstadoCuentaAhorroAnterior' }
        : null;

  if (!statement) {
    console.log(
      `Skipping savings account ${accountNumber} for ${target}: Banco Industrial publishes savings ` +
        `statements only for the current and previous month (${now.format('YYYY-MM')} / ` +
        `${now.subtract(1, 'month').format('YYYY-MM')}). Stored rows for ${target} are left alone.`,
    );
    return null;
  }

  await waitRandomMs();
  await page.getByRole('link', { name: 'Información de cuentas' }).click();
  await waitRandomMs();
  await page.getByRole('link', { name: 'Ahorros' }).click();
  await page.waitForURL(
    'https://www.bienlinea.bi.com.gt/InformacionCuentas/Ahorro/InformacionCuentasAhorro/InformacionCuentaAhorroAmbas**',
  );
  await waitRandomMs();

  // Scoped to the account's own row: each row's menu links carry a `CuentaCifrada` token that is
  // regenerated on every render, so the statement URL can't be built or cached — the menu has to be
  // walked each time. The account number is a LINK here; the monetary listing renders it as a plain
  // gridcell, which is why that scraper's row locator doesn't transfer.
  const row = page
    .locator('tr')
    .filter({ has: page.getByRole('link', { name: accountNumber, exact: true }) });
  await row.locator('.btns-options').click();
  await waitRandomMs();
  await row.getByRole('link', { name: statement.link, exact: true }).click();
  await page.waitForURL(
    `https://www.bienlinea.bi.com.gt/InformacionCuentas/Ahorro/InformacionCuentasAhorro/${statement.path}**`,
  );

  const transactions = await readStatementRows(page);

  // ACTUAL/ANTERIOR are relative to the BANK's clock, not ours, so a run near a month boundary (or
  // a timezone difference) could serve a different month than asked for. Verify against the rows
  // themselves before the caller treats them as this month's complete truth and deletes the rest.
  const expectedMonth = monthDayJs.month() + 1;
  for (const tx of transactions) {
    const scrapedMonth = Number(tx.date.match(DAY_MONTH)?.[2]);
    if (scrapedMonth !== expectedMonth) {
      throw new Error(
        `Banco Industrial served the ${statement.link} savings statement for month ` +
          `${scrapedMonth} of account ${accountNumber}, but ${target} was requested.`,
      );
    }
  }

  return transactions;
}

/** Monetary ("Monetarias" / checking) statements, which do support an arbitrary date range. */
async function getMonetaryAccountTransactions(
  page: Page,
  accountNumber: string,
  monthDayJs: dayjs.Dayjs,
): Promise<RawTx[]> {
  await waitRandomMs();
  await page.getByRole('link', { name: 'Información de cuentas' }).click();
  await waitRandomMs();
  await page.getByRole('link', { name: 'Monetarias' }).click();
  await page.waitForURL(
    'https://www.bienlinea.bi.com.gt/InformacionCuentas/Monetario/InformacionCuentasMonetaria/**',
  );
  await waitRandomMs();
  await page
    .locator('tr')
    .filter({ has: page.getByRole('gridcell', { name: accountNumber }) })
    .locator('.btns-options')
    .click();
  await waitRandomMs();
  await page.getByRole('link', { name: 'HISTÓRICO' }).click();
  await page.waitForURL(
    'https://www.bienlinea.bi.com.gt/InformacionCuentas/Monetario/InformacionCuentasMonetaria/Historico**',
  );
  await waitRandomMs();
  await page.getByRole('link', { name: 'Personalizado' }).click();
  await waitRandomMs();

  await page.locator('#txtFechaInicial').evaluate((el: HTMLInputElement, dateStr) => {
    el.value = dateStr;
  }, monthDayJs.startOf('month').format('DD/MM/YYYY'));
  await waitRandomMs();

  await page.locator('#txtFechaFinal').evaluate((el: HTMLInputElement, dateStr) => {
    el.value = dateStr;
  }, monthDayJs.endOf('month').format('DD/MM/YYYY'));
  await waitRandomMs();

  await page.getByRole('button', { name: 'Consultar' }).click();
  await page.waitForURL(
    'https://www.bienlinea.bi.com.gt/InformacionCuentas/Monetario/InformacionCuentasMonetaria/ConsultaPersonalizada**',
  );
  return readStatementRows(page);
}
