import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { type Page } from 'playwright';
import { isMatching } from 'ts-pattern';
import { db, type DB, type InsertObject } from '../db';
import { waitRandomMs } from '../utils';

dayjs.extend(customParseFormat);

export async function bacGtScrape({
  config,
  months,
  page,
}: {
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
  page: Page;
}) {
  const bankKey = process.env.BANK_KEY;
  console.log(
    `Scraping BAC GT transactions for months: ${months
      .map((m) => m.format('YYYY-MM'))
      .join(', ')}`
  );
  const createTxs: InsertObject<DB, 'bank_txs'>[] = [];
  const deleteTxIds: string[] = [];

  await page.goto('https://www.baccredomatic.com/');
  await waitRandomMs();
  await page
    .locator('.country__button')
    .filter({ hasText: 'Guatemala' })
    .click();
  await page.waitForURL('https://www.baccredomatic.com/es-gt');
  await waitRandomMs();
  await page
    .locator('.secondary-menu__item')
    .filter({ hasText: 'Banca en Línea' })
    .click();
  await waitRandomMs();
  await page
    .getByRole('textbox', { name: 'Usuario' })
    .fill(config.auth.username);
  await waitRandomMs();
  await page
    .getByRole('textbox', { name: 'Contraseña' })
    .fill(config.auth.password);
  await waitRandomMs();
  await page.locator('.login-form__submit-btn').click();
  await page.waitForURL(
    '**/ebac/module/consolidatedQuery/consolidatedQuery.go'
  );
  const host = await page.evaluate(() => window.location.host);
  for (const account of config.accounts) {
    await waitRandomMs();
    await page.goto(
      `https://${host}/ebac/module/consolidatedQuery/consolidatedQuery.go`
    );
    if (account.type === 'checking') {
      await waitRandomMs();
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
        `https://${host}/ebac/module/accountbalance/accountBalance.go`
      );
      for (const monthDayJs of months) {
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
              date: tr.querySelector('td:nth-of-type(1)')!.textContent!.trim(),
              docNo: tr.querySelector('td:nth-of-type(2)')!.textContent!.trim(),
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
        )
          .map((tx) => {
            if (tx.description === 'No hay detalle de movimientos') {
              return null;
            }
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
          })
          .filter((tx) => !!tx);
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
}
