import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import type { Page } from 'playwright';
import { isMatching } from 'ts-pattern';
import type { z } from 'zod';
import type { bacSchema } from '../config-schema';
import { db, type bankTx } from '@bank-bots/db';
import { ensureBankAccount } from '../bank-accounts';
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
      .join(', ')}`,
  );
  const createTxs: (typeof bankTx.$inferInsert)[] = [];
  const deleteTxIds: string[] = [];
  // running_balance_cents = the last row's "Balance" (in cents) on the current month, per account.
  const runningBalances: Record<string, number> = {};
  const currentMonth = dayjs().format('YYYY-MM');

  await page.goto('https://www.baccredomatic.com/');
  await waitRandomMs();
  await page.locator('[data-country]').filter({ hasText: config.country }).click();
  await page.waitForLoadState('networkidle');
  await waitRandomMs();
  await page.locator('.secondary-menu__item').filter({ hasText: 'Banca en Línea' }).click();
  await waitRandomMs();
  await page.getByRole('textbox', { name: 'Usuario' }).fill(config.auth.username);
  await waitRandomMs();
  await page.getByRole('textbox', { name: 'Contraseña' }).fill(config.auth.password);
  await waitRandomMs();
  await page.locator('#confirm').click();
  // BAC blocks concurrent sessions: if a session is already open (a prior run/login didn't press
  // SALIR, or the owner is logged in elsewhere) login lands on a full "AVISO DE SESIONES ACTIVAS"
  // page (`/ebac/common/showSessionRestriction.go`) instead of the dashboard. Its CONTINUAR control
  // is a <div class="button-form button-position-right">Continuar</div> (not a button/link — so
  // match it by tag+text). Wait for whichever comes first — that page or the dashboard — and click
  // CONTINUAR to take over the session.
  const dashboardUrl = '**/ebac/module/consolidatedQuery/consolidatedQuery.go';
  const continuarBtn = page.locator('div.button-form').filter({ hasText: 'Continuar' });
  const outcome = await Promise.race([
    continuarBtn
      .waitFor({ state: 'visible', timeout: 30000 })
      .then(() => 'modal' as const)
      .catch(() => 'timeout' as const),
    page
      .waitForURL(dashboardUrl, { timeout: 30000 })
      .then(() => 'dashboard' as const)
      .catch(() => 'timeout' as const),
  ]);
  if (outcome === 'modal') {
    await continuarBtn.click();
  }
  await page.waitForURL(dashboardUrl);
  const host = await page.evaluate(() => window.location.host);
  for (const account of config.accounts) {
    const bankAccountId = await ensureBankAccount({
      bankKey,
      accountNumber: account.number,
      type: account.type,
    });
    const accountScrapedTxs: (typeof bankTx.$inferInsert)[] = [];
    const accountCurrentTxs = await db.query.bankTx.findMany({
      where: (t, { and, eq, inArray }) =>
        and(
          eq(t.bankAccountId, bankAccountId),
          inArray(
            t.month,
            months.map((m) => m.format('YYYY-MM')),
          ),
        ),
    });

    await waitRandomMs();
    await page.goto(`https://${host}/ebac/module/consolidatedQuery/consolidatedQuery.go`);
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
      await page.waitForURL(`https://${host}/ebac/module/accountbalance/accountBalance.go`);
      for (const monthDayJs of months) {
        await waitRandomMs();
        let monthStr = monthDayJs.toDate().toLocaleDateString('es-ES', { month: 'long' });
        monthStr = `${monthStr[0].toUpperCase()}${monthStr.slice(1).toLowerCase()}`;
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
              document.querySelectorAll('#transactionTable1 tbody tr:not(.bel-table_row__neutral)'),
            ).map((tr) => ({
              date: tr.querySelector('td:nth-of-type(1)')!.textContent!.trim(),
              docNo: tr.querySelector('td:nth-of-type(2)')!.textContent!.trim(),
              description: tr.querySelector('td:nth-of-type(3)')!.textContent!.trim(),
              debit: tr.querySelector('td:nth-of-type(4)')!.textContent!.trim().replace(/,/g, ''),
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
              bankAccountId,
              month: monthDayJs.format('YYYY-MM'),
              date: date.format('YYYY-MM-DD'),
              description: tx.description,
              docNo: tx.docNo,
              amountCents: debit ? -Math.round(debit * 100) : Math.round(credit * 100),
            };
          })
          .filter((tx) => !!tx);
        accountScrapedTxs.push(...scrapedConfirmedTxs);

        // Capture the ledger balance from the current month's statement: the last data row's
        // "Balance" column (td:6). This is Saldo disponible + Retenido — reconcile vs SUM(bank_tx).
        if (monthDayJs.format('YYYY-MM') === currentMonth) {
          const lastBalance = await page.evaluate(() => {
            const rows = document.querySelectorAll(
              '#transactionTable1 tbody tr:not(.bel-table_row__neutral)',
            );
            const cell = rows[rows.length - 1]?.querySelector('td:nth-of-type(6)');
            return cell?.textContent?.trim() ?? null;
          });
          const dollars = lastBalance ? parseFloat(lastBalance.replace(/,/g, '')) : NaN;
          if (!Number.isNaN(dollars)) {
            runningBalances[bankAccountId] = Math.round(dollars * 100);
          }
        }
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
            return !accountScrapedTxs.some((scrapedTx) => isMatching(objToMatch, scrapedTx));
          })
          .map((tx) => tx.id),
      );
      createTxs.push(...accountScrapedTxs);
    }
  }
  await page.locator('a.icon-exit').click();
  return { createTxs, deleteTxIds, runningBalances };
}
