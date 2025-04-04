import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { type Page } from 'playwright';
import { isMatching } from 'ts-pattern';
import type { z } from 'zod';
import type { bacSchema } from '../config-schema';
import { db, type DB, type InsertObject } from '../db';
import { waitRandomMs } from '../utils';

dayjs.extend(customParseFormat);

export async function bacScrape({
  bankKey,
  config,
  months,
  page,
}: {
  bankKey: string;
  config: z.infer<typeof bacSchema>;
  months: dayjs.Dayjs[];
  page: Page;
}) {
  console.log(
    `Scraping BAC ${config.country} transactions for months: ${months
      .map((m) => m.format('YYYY-MM'))
      .join(', ')}`
  );
  const createTxs: InsertObject<DB, 'bank_txs'>[] = [];
  const deleteTxIds: string[] = [];

  await page.goto('https://www.baccredomatic.com/');
  await waitRandomMs();
  await page
    .locator('.country__button')
    .filter({ hasText: config.country })
    .click();
  await page.waitForLoadState('networkidle');
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
    const accountScrapedTxs: InsertObject<DB, 'bank_txs'>[] = [];
    const accountCurrentTxs = await db
      .selectFrom('bank_txs')
      .selectAll()
      .where('bank_key', '=', bankKey)
      .where('account_number', '=', account.number)
      .where(
        'month',
        'in',
        months.map((m) => m.format('YYYY-MM'))
      )
      .execute();

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
        await waitRandomMs();
        let monthStr = monthDayJs
          .toDate()
          .toLocaleDateString('es-ES', { month: 'long' });
        monthStr = `${monthStr[0].toUpperCase()}${monthStr
          .slice(1)
          .toLowerCase()}`;
        // confirmadas
        await page.locator('#selectMonthLabel').click();
        await waitRandomMs();
        await page
          .locator('#selectMonthList')
          .getByText(`${monthStr} ${monthDayJs.year()}`)
          .click();
        await waitRandomMs();
        const scrapedConfirmedTxs = (
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
        accountScrapedTxs.push(...scrapedConfirmedTxs);
      }
      // // retenidos y diferidos
      // await page.getByText('Retenidos y Diferidos', { exact: true }).click();
      // // compras recientes y sobregiros
      // await page.locator('#recentPurchasesTable').isVisible();
      // await page.waitForLoadState('networkidle');
      // await new Promise((resolve) => setTimeout(resolve, 2000));

      // const recentPurchases = (
      //   await page.evaluate(() => {
      //     return Array.from(
      //       document.querySelectorAll('#recentPurchasesTable tbody tr')
      //     ).map((tr) => {
      //       try {
      //         return {
      //           date: tr
      //             .querySelector('td:nth-of-type(1)')!
      //             .textContent!.trim(),
      //           docNo: tr
      //             .querySelector('td:nth-of-type(2)')!
      //             .textContent!.trim(),
      //           description: tr
      //             .querySelector('td:nth-of-type(3)')!
      //             .textContent!.trim(),
      //           debit: tr
      //             .querySelector('td:nth-of-type(4)')!
      //             .textContent!.trim()
      //             .replace(/,/g, ''),
      //         };
      //       } catch {
      //         return null;
      //       }
      //     });
      //   })
      // )
      //   .map((tx) => {
      //     if (!tx) {
      //       return null;
      //     }
      //     const date = dayjs(`${tx.date}/${dayjs().year()}`, 'DD/MM/YYYY');
      //     if (!months.some((m) => m.isSame(date, 'month'))) {
      //       return null;
      //     }
      //     const debit = parseFloat(tx.debit);
      //     if (!debit || isNaN(debit)) {
      //       return null;
      //     }
      //     return {
      //       bank_key: bankKey,
      //       account_number: account.number,
      //       month: date.format('YYYY-MM'),
      //       date: date.format('YYYY-MM-DD'),
      //       description: tx.description,
      //       doc_no: tx.docNo,
      //       amount: -Number(debit),
      //     };
      //   })
      //   .filter((tx) => !!tx);
      // accountScrapedTxs.push(...recentPurchases);

      // // retenidos y deferidos
      // const retainedAndDeferred = (
      //   await page.evaluate(() => {
      //     return Array.from(
      //       document.querySelectorAll('#retainedAndDeferredTable tbody tr')
      //     ).map((tr) => {
      //       try {
      //         return {
      //           date: tr
      //             .querySelector('td:nth-of-type(1)')!
      //             .textContent!.trim(),
      //           docNo: tr
      //             .querySelector('td:nth-of-type(3)')!
      //             .textContent!.trim(),
      //           description: tr
      //             .querySelector('td:nth-of-type(4)')!
      //             .textContent!.trim(),
      //           debit: tr
      //             .querySelector('td:nth-of-type(5)')!
      //             .textContent!.trim()
      //             .replace(/,/g, ''),
      //         };
      //       } catch {
      //         return null;
      //       }
      //     });
      //   })
      // )
      //   .map((tx) => {
      //     if (!tx) {
      //       return null;
      //     }
      //     const date = dayjs(tx.date, 'DD/MM/YYYY');
      //     if (!months.some((m) => m.isSame(date, 'month'))) {
      //       return null;
      //     }
      //     const debit = parseFloat(tx.debit);
      //     if (!debit || isNaN(debit)) {
      //       return null;
      //     }
      //     return {
      //       bank_key: bankKey,
      //       account_number: account.number,
      //       month: date.format('YYYY-MM'),
      //       date: date.format('YYYY-MM-DD'),
      //       description: tx.description,
      //       doc_no: tx.docNo,
      //       amount: -Number(debit),
      //     };
      //   })
      //   .filter((tx) => !!tx);
      // accountScrapedTxs.push(...retainedAndDeferred);

      deleteTxIds.push(
        ...accountCurrentTxs
          .filter((currentTx) => {
            const objToMatch = {
              bank_key: currentTx.bank_key,
              account_number: currentTx.account_number,
              date: dayjs(currentTx.date).format('YYYY-MM-DD'),
              doc_no: currentTx.doc_no,
              description: currentTx.description,
              amount: Number(currentTx.amount),
            };
            return !accountScrapedTxs.some((bankTx) =>
              isMatching(objToMatch, bankTx)
            );
          })
          .map((tx) => tx.id)
      );
      createTxs.push(...accountScrapedTxs);
    }
  }
  await page.locator('a.icon-exit').click();
  return { createTxs, deleteTxIds };
}
