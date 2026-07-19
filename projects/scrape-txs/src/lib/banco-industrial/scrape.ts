import type dayjs from 'dayjs';
import type { Page } from 'playwright';
import { isMatching } from 'ts-pattern';
import type { AccountType } from '../types';
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
    if (account.type === 'checking') {
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
        const rawTransactions = await getMonetaryAccountTransactions(
          page,
          account.number,
          monthDayJs,
        );
        const _bankTxs: (typeof bankTx.$inferInsert)[] = rawTransactions.map((tx) => {
          const [_, dateStr] = tx.date.match(/(\d\d)\s-\s(\d\d)/)!;
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
            if (currentTx.docNo === 'RECONCILE') return false;
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
  }
  return { createTxs, deleteTxIds };
}

async function getMonetaryAccountTransactions(
  page: Page,
  accountNumber: string,
  monthDayJs: dayjs.Dayjs,
) {
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
  const transactions = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tbl-report tbody tr')).map((tr) => ({
      date: tr.querySelector('td:nth-child(1)')!.textContent!.trim(),
      type: tr.querySelector('td:nth-child(2)')!.textContent!.trim(),
      description: tr.querySelector('td:nth-child(3)')!.textContent!.trim(),
      docNo: tr.querySelector('td:nth-child(4)')!.textContent!.trim(),
      debit: tr.querySelector('td:nth-child(5)')!.textContent!.trim().replace(/,/g, ''),
      credit: tr.querySelector('td:nth-child(6)')!.textContent!.trim().replace(/,/g, ''),
    }));
  });
  return transactions;
}
