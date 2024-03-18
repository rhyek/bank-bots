import type dayjs from 'dayjs';
import { chromium, type Browser, type Page } from 'playwright';
import { launchChromium } from 'playwright-aws-lambda';
import { groupBy } from 'lodash';
import Decimal from 'decimal.js';
import type { AccountType } from '../types';
import { db, type InsertObject, type DB } from '../db';

function isLambda() {
  return !!process.env['AWS_LAMBDA_FUNCTION_NAME'];
}

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
  const browser = isLambda()
    ? ((await launchChromium({
        headless: true,
      })) as Browser)
    : await chromium.launch({
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
        debit: tr
          .querySelector('td:nth-child(5)')!
          .textContent!.trim()
          .replace(/,/g, ''),
        credit: tr
          .querySelector('td:nth-child(6)')!
          .textContent!.trim()
          .replace(/,/g, ''),
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

export async function bancoIndustrialScrape({
  biConfig: { auth, accounts },
  months,
}: {
  biConfig: BiConfig;
  months: dayjs.Dayjs[];
}) {
  console.log(
    `Scraping Banco Industrial GT transactions for months: ${months
      .map((m) => m.format('YYYY-MM'))
      .join(', ')}`
  );
  const ctx = await login(auth);
  try {
    const bankTxs: InsertObject<DB, 'bank_txs'>[] = [];
    for (const account of accounts) {
      if (account.type === 'checking') {
        for (const monthDayJs of months) {
          const rawTransactions = await getMonetaryAccountTransactions(
            ctx.page,
            account.number,
            monthDayJs
          );
          bankTxs.push(
            ...Object.values(
              groupBy(
                rawTransactions.map((tx) => {
                  const [_, dateStr] = tx.date.match(/(\d\d)\s-\s(\d\d)/)!;
                  const amount =
                    tx.credit && tx.credit !== ''
                      ? Number(tx.credit)
                      : -Number(tx.debit);
                  return {
                    bank_key: 'bancoIndustrialGt',
                    tx_key: `bi.gt-${account.number}-${monthDayJs.format(
                      'YYYYMMDD'
                    )}-${tx.docNo}`,
                    account_number: account.number,
                    month: monthDayJs.format('YYYY-MM'),
                    date: monthDayJs.date(Number(dateStr)).format('YYYY-MM-DD'),
                    description: tx.description,
                    doc_no: tx.docNo,
                    amount,
                  };
                }),
                (tx) => tx.tx_key
              )
            ).map((txs) => ({
              ...txs[0],
              description:
                txs.find(
                  (tx) => tx.description !== 'CONSUMO TARJETA ELECTRON VISA'
                )?.description ?? txs[0].description,
              amount: txs
                .reduce((acc, tx) => acc.add(tx.amount), new Decimal(0))
                .toDecimalPlaces(2)
                .toNumber(),
            }))
          );
        }
      }
    }
    if (bankTxs.length > 0) {
      console.log(
        `Inserting/updating ${bankTxs.length} Banco Industrial GT transactions...`
      );
      await db.transaction().execute(async (sqlTx) => {
        await Promise.all(
          bankTxs.map(async (bankTx) => {
            await sqlTx
              .insertInto('bank_txs')
              .values(bankTx)
              .onConflict((oc) =>
                oc.column('tx_key').doUpdateSet({ amount: bankTx.amount })
              )
              .execute();
          })
        );
      });
      console.log('Done.');
    }
  } finally {
    await ctx.context.close();
    await ctx.browser.close();
  }
}
