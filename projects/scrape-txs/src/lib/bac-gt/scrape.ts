import { launchChromium } from 'playwright-aws-lambda';
import { chromium, type Browser } from 'playwright';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { isLambda, waitRandomMs } from '../utils';
import { db, type DB, type InsertObject } from '../db';
import { isMatching } from 'ts-pattern';

dayjs.extend(customParseFormat);

export async function bacGtScrape(params: {
  config: {
    auth: {
      username: string;
      password: string;
    };
    accounts: {
      type: 'checking' | 'creditcard';
      number: string;
    }[];
  };
  months: dayjs.Dayjs[];
}) {
  const bankKey = process.env.BANK_KEY;
  console.log(
    `Scraping BAC GT transactions for months: ${params.months
      .map((m) => m.format('YYYY-MM'))
      .join(', ')}`
  );
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
  const createTxs: InsertObject<DB, 'bank_txs'>[] = [];
  const deleteTxIds: string[] = [];
  try {
    const page = await context.newPage();
    await page.goto('https://www1.sucursalelectronica.com/redir/showLogin.go');
    await page.locator('#navbarDropdownCountry').click();
    await waitRandomMs();
    await page.locator('#navbarDropdownMenu').getByText('Guatemala').click();
    await waitRandomMs();
    await page
      .getByRole('textbox', { name: 'Usuario' })
      .fill(params.config.auth.username);
    await waitRandomMs();
    await page
      .getByRole('textbox', { name: 'Contraseña' })
      .fill(params.config.auth.password);
    await waitRandomMs();
    await page.locator('#confirm').click();
    await page.waitForURL(
      'https://www1.sucursalelectronica.com/ebac/module/consolidatedQuery/consolidatedQuery.go'
    );
    for (const account of params.config.accounts) {
      await page.goto(
        'https://www1.sucursalelectronica.com/ebac/module/consolidatedQuery/consolidatedQuery.go'
      );
      if (account.type === 'checking') {
        await page
          .locator('.bel-card')
          .filter({ has: page.getByText('Cuentas bancarias') })
          .locator('tr')
          .filter({
            has: page.getByRole('cell', { name: account.number }),
          })
          .locator(`form[name^="BankAccountBalanceItem"] > button`)
          .click();
        await page.waitForURL(
          'https://www1.sucursalelectronica.com/ebac/module/accountbalance/accountBalance.go'
        );
        for (const monthDayJs of params.months) {
          const currentTxs = await db
            .selectFrom('bank_txs')
            .selectAll()
            .where('bank_key', '=', bankKey)
            .where('account_number', '=', account.number)
            .where('month', '=', monthDayJs.format('YYYY-MM'))
            .execute();
          await waitRandomMs();
          let monthStr = monthDayJs
            .toDate()
            .toLocaleDateString('es-ES', { month: 'long' });
          monthStr = `${monthStr[0].toUpperCase()}${monthStr
            .slice(1)
            .toLowerCase()}`;
          await page.locator('#selectMonthLabel').click();
          await waitRandomMs();
          await page
            .locator('#selectMonthList')
            .getByText(`${monthStr} ${monthDayJs.year()}`)
            .click();
          await waitRandomMs();
          const transactions = (
            await page.evaluate(() => {
              return Array.from(
                document.querySelectorAll(
                  '#transactionTable1 tbody tr:not(.bel-table_row__neutral)'
                )
              ).map((tr) => ({
                date: tr
                  .querySelector('td:nth-of-type(1)')!
                  .textContent!.trim(),
                docNo: tr
                  .querySelector('td:nth-of-type(2)')!
                  .textContent!.trim(),
                description: tr
                  .querySelector('td:nth-of-type(3)')!
                  .textContent!.trim(),
                debit: tr
                  .querySelector('td:nth-of-type(4)')!
                  .textContent!.trim()
                  .replace(/,/g, ''),
                credit: tr
                  .querySelector('td:nth-of-type(5)')!
                  .textContent!.trim()
                  .replace(/[+,]/g, ''),
              }));
            })
          ).map((tx) => {
            const date = dayjs(tx.date, 'DD/MM/YYYY');
            const debit = parseFloat(tx.debit);
            const credit = parseFloat(tx.credit);
            return {
              bank_key: bankKey,
              account_number: account.number,
              month: monthDayJs.format('YYYY-MM'),
              date: date.format('YYYY-MM-DD'),
              description: tx.description,
              doc_no: tx.docNo,
              amount: debit ? -Number(debit) : credit,
            };
          });
          createTxs.push(...transactions);
          deleteTxIds.push(
            ...currentTxs
              .filter((currentTx) => {
                const objToMatch = {
                  bank_key: currentTx.bank_key,
                  account_number: currentTx.account_number,
                  date: dayjs(currentTx.date).format('YYYY-MM-DD'),
                  doc_no: currentTx.doc_no,
                  description: currentTx.description,
                  amount: Number(currentTx.amount),
                };
                return !transactions.some((bankTx) =>
                  isMatching(objToMatch, bankTx)
                );
              })
              .map((tx) => tx.id)
          );
        }
      }
    }
    await page.locator('a.icon-exit').click();
    return { createTxs, deleteTxIds };
  } finally {
    await context.close();
    await browser.close();
  }
}
