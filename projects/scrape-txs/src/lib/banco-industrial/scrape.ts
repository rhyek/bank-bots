import dayjs from 'dayjs';
import { type Page } from 'playwright';
import { isMatching } from 'ts-pattern';
import type { AccountType } from '../types';
import { db, type InsertObject, type DB } from '../db';
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
  biConfig: { auth, accounts },
  months,
  page,
}: {
  biConfig: BiConfig;
  months: dayjs.Dayjs[];
  page: Page;
}) {
  const bankKey = process.env.BANK_KEY;
  console.log(
    `Scraping Banco Industrial GT transactions for months: ${months
      .map((m) => m.format('YYYY-MM'))
      .join(', ')}`,
  );
  await page.goto(
    'https://www.bienlinea.bi.com.gt/InicioSesion/Inicio/Autenticar',
  );
  await page.getByRole('textbox', { name: 'Código' }).fill(auth.code);
  await waitRandomMs();
  await page.getByRole('textbox', { name: 'Usuario' }).fill(auth.username);
  await waitRandomMs();
  await page.getByPlaceholder('Contraseña').fill(auth.password);
  await waitRandomMs();
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();

  await page.waitForURL(
    'https://www.bienlinea.bi.com.gt/InicioSesion/Token/BienvenidoDashBoard',
  );
  const createTxs: InsertObject<DB, 'bank_txs'>[] = [];
  const deleteTxIds: string[] = [];
  for (const account of accounts) {
    if (account.type === 'checking') {
      for (const monthDayJs of months) {
        const currentTxs = await db
          .selectFrom('bank_txs')
          .selectAll()
          .where('bank_key', '=', bankKey)
          .where('account_number', '=', account.number)
          .where('month', '=', monthDayJs.format('YYYY-MM'))
          .execute();
        const rawTransactions = await getMonetaryAccountTransactions(
          page,
          account.number,
          monthDayJs,
        );
        const _bankTxs = rawTransactions.map((tx) => {
          const [_, dateStr] = tx.date.match(/(\d\d)\s-\s(\d\d)/)!;
          const amount =
            tx.credit && tx.credit !== ''
              ? Number(tx.credit)
              : -Number(tx.debit);
          return {
            bank_key: bankKey,
            account_number: account.number,
            month: monthDayJs.format('YYYY-MM'),
            date: monthDayJs.date(Number(dateStr)).format('YYYY-MM-DD'),
            description: tx.description,
            doc_no: tx.docNo,
            amount,
          };
        });
        const _deleteTxIds = currentTxs
          .filter((currentTx) => {
            const objToMatch = {
              bank_key: currentTx.bank_key,
              account_number: currentTx.account_number,
              date: dayjs(currentTx.date).format('YYYY-MM-DD'),
              doc_no: currentTx.doc_no,
              description: currentTx.description,
              amount: Number(currentTx.amount),
            };
            return !_bankTxs.some((bankTx) => isMatching(objToMatch, bankTx));
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

  await page
    .locator('#txtFechaInicial')
    .evaluate((el: HTMLInputElement, dateStr) => {
      el.value = dateStr;
    }, monthDayJs.startOf('month').format('DD/MM/YYYY'));
  await waitRandomMs();

  await page
    .locator('#txtFechaFinal')
    .evaluate((el: HTMLInputElement, dateStr) => {
      el.value = dateStr;
    }, monthDayJs.endOf('month').format('DD/MM/YYYY'));
  await waitRandomMs();

  await page.getByRole('button', { name: 'Consultar' }).click();
  await page.waitForURL(
    'https://www.bienlinea.bi.com.gt/InformacionCuentas/Monetario/InformacionCuentasMonetaria/ConsultaPersonalizada**',
  );
  const transactions = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tbl-report tbody tr')).map(
      (tr) => ({
        date: tr.querySelector('td:nth-child(1)')!.textContent!.trim(),
        type: tr.querySelector('td:nth-child(2)')!.textContent!.trim(),
        description: tr.querySelector('td:nth-child(3)')!.textContent!.trim(),
        docNo: tr.querySelector('td:nth-child(4)')!.textContent!.trim(),
        debit: tr
          .querySelector('td:nth-child(5)')!
          .textContent!.trim()
          .replace(/,/g, ''),
        credit: tr
          .querySelector('td:nth-child(6)')!
          .textContent!.trim()
          .replace(/,/g, ''),
      }),
    );
  });
  return transactions;
}
