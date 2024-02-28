import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import dayjs from 'dayjs';
import Decimal from 'decimal.js';
import { groupBy } from 'lodash';
import {
  type BankAccountWithTransactions,
  TransactionType,
  AccountType,
  type BankTransaction,
} from '../../../types/types';

function waitRandomMs() {
  const randomMilliSeconds =
    Math.floor(Math.random() * (3000 - 1000 + 1)) + 1000;

  return new Promise<void>((resolve) => {
    console.log(`Waiting for ${randomMilliSeconds} ms...`);
    setTimeout(() => {
      console.log('Done waiting.');
      resolve();
    }, randomMilliSeconds);
  });
}

async function login(auth: {
  code: string;
  username: string;
  password: string;
}) {
  const browser = await chromium.launch({
    headless: false,
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  await page.goto(
    'https://www.bienlinea.bi.com.gt/InicioSesion/Inicio/Autenticar'
  );
  await page.getByRole('textbox', { name: 'Código' }).fill(auth.code);
  await waitRandomMs();
  await page.getByRole('textbox', { name: 'Usuario' }).fill(auth.username);
  await waitRandomMs();
  await page.getByPlaceholder('Contraseña').fill(auth.password);
  await waitRandomMs();
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.waitForURL(
    'https://www.bienlinea.bi.com.gt/InicioSesion/Token/BienvenidoDashBoard'
  );
  return { browser, context, page };
}

async function getMonetaryAccountTransactions(
  page: Page,
  accountNumber: string,
  monthDayJs: dayjs.Dayjs
) {
  await waitRandomMs();
  await page.getByRole('link', { name: 'Información de cuentas' }).click();
  await waitRandomMs();
  await page.getByRole('link', { name: 'Monetarias' }).click();
  await page.waitForURL(
    'https://www.bienlinea.bi.com.gt/InformacionCuentas/Monetario/InformacionCuentasMonetaria/**'
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
    'https://www.bienlinea.bi.com.gt/InformacionCuentas/Monetario/InformacionCuentasMonetaria/Historico**'
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
    'https://www.bienlinea.bi.com.gt/InformacionCuentas/Monetario/InformacionCuentasMonetaria/ConsultaPersonalizada**'
  );
  const transactions = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tbl-report tbody tr')).map(
      (tr) => ({
        date: tr.querySelector('td:nth-child(1)')!.textContent!.trim(),
        type: tr.querySelector('td:nth-child(2)')!.textContent!.trim(),
        description: tr.querySelector('td:nth-child(3)')!.textContent!.trim(),
        docNo: tr.querySelector('td:nth-child(4)')!.textContent!.trim(),
        debit: (
          tr.querySelector('td:nth-child(5)')!.textContent!.trim() || '0'
        ).replace(/,/g, ''),
        credit: (
          tr.querySelector('td:nth-child(6)')!.textContent!.trim() || '0'
        ).replace(/,/g, ''),
      })
    );
  });
  return transactions;
}

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

export async function getBancoIndustrialTransactions({
  biConfig: { auth, accounts },
  months,
  real,
}: {
  biConfig: BiConfig;
  months: dayjs.Dayjs[];
  real: boolean;
}) {
  const ctx = real ? await login(auth) : null;

  const bankAccountWithTransactions: BankAccountWithTransactions[] = [];

  for (const account of accounts) {
    const transactions: BankTransaction[] = [];
    bankAccountWithTransactions.push({
      account,
      transactions,
    });
    if (account.type === 'checking') {
      for (const monthDayJs of months) {
        let rawTransactions: {
          date: string;
          type: string;
          description: string;
          docNo: string;
          debit: string;
          credit: string;
        }[] = await (async () => {
          if (ctx) {
            const rawTransactions = await getMonetaryAccountTransactions(
              ctx.page,
              account.number,
              monthDayJs
            );
            await fs.writeFile(
              path.resolve(__dirname, '../raw-transactions.json'),
              JSON.stringify(rawTransactions, null, 2),
              'utf-8'
            );
            return rawTransactions;
          } else {
            return JSON.parse(
              await fs.readFile(
                path.resolve(__dirname, '../raw-transactions.json'),
                'utf-8'
              )
            );
          }
        })();

        const grouped = groupBy(rawTransactions, (tx) => tx.docNo);
        rawTransactions = Object.entries(grouped).map(([, txs]) => ({
          ...txs[0],
          description:
            txs.find(({ description }) => !description.match(/\belectron\b/i))
              ?.description ?? txs[0].description,
          debit: txs.reduce(
            (acc, tx) => new Decimal(acc).add(tx.debit).toString(),
            '0'
          ),
          credit: txs.reduce(
            (acc, tx) => new Decimal(acc).add(tx.credit).toString(),
            '0'
          ),
        }));

        transactions.push(
          ...rawTransactions.map((tx: any) => {
            const [_, dateStr] = tx.date.match(/(\d\d)\s-\s(\d\d)/)!;
            const date = monthDayJs.date(Number(dateStr));
            const docNo = tx.docNo;
            const ref = `${date.format('YYYYMMDD')}_${docNo}`;
            const amount =
              tx.credit && tx.credit !== '0'
                ? Number(tx.credit)
                : -Number(tx.debit);
            return {
              ref,
              year: date.year(),
              month: date.month() + 1,
              date: date.date(),
              docNo,
              description: tx.description,
              amount,
              type: amount < 0 ? TransactionType.Debit : TransactionType.Credit,
            };
          })
        );
      }
    }
    transactions.sort((a, b) => {
      if (a.year !== b.year) {
        return a.year - b.year;
      }
      if (a.month !== b.month) {
        return a.month - b.month;
      }
      return a.date - b.date;
    });
  }

  await fs.writeFile(
    path.resolve(__dirname, '../transactions.json'),
    JSON.stringify(bankAccountWithTransactions, null, 2),
    'utf-8'
  );

  if (ctx) {
    await ctx.context.close();
    await ctx.browser.close();
  }

  return bankAccountWithTransactions;
}

// await page.goto('https://www.bienlinea.bi.com.gt/InicioSesion/Inicio/Autenticar');
// await page.getByRole('textbox', { name: 'Código ' }).click();
// await page.getByRole('textbox', { name: 'Código ' }).fill('1687064');
// await page.getByRole('textbox', { name: 'Usuario ' }).click();
// await page.getByRole('textbox', { name: 'Usuario ' }).fill('rhyek');
// await page.getByPlaceholder('Contraseña').click();
// await page.getByPlaceholder('Contraseña').fill('ewVZ3Ac4QAGn7R7');
// await page.getByRole('button', { name: ' Iniciar sesión' }).click();
// await page.getByRole('button', { name: 'Configurar información' }).click();
// await page.getByPlaceholder('Configura tu contraseña').click();
// await page.getByPlaceholder('Configura tu contraseña').click();
// await page.getByPlaceholder('Configura tu contraseña').fill('2XhaPF4RuBpeuCR');
// await page.getByPlaceholder('Confirma tu contraseña').click();
// await page.getByPlaceholder('Confirma tu contraseña').fill('2XhaPF4RuBpeuCR');
// await page.getByRole('button', { name: 'Configurar contraseña' }).click();
// await page.goto('https://www.bienlinea.bi.com.gt/InicioSesion/Inicio/Autenticar');
