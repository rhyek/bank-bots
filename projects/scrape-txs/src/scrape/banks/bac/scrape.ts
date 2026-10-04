import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import type { Page } from 'playwright';
import { isMatching } from 'ts-pattern';
import type { z } from 'zod';
import type { bacSchema } from '~/bank-config/config-schema';
import type { BankCredentials } from '~/credentials/bitwarden';
import { db, type bankTx } from '@bank-bots/db';
import { ensureBankAccount } from '../bank-accounts';
import { numberOccurrences } from '../occurrences';
import { type ScrapeLog, waitRandomMs } from '../utils';

dayjs.extend(customParseFormat);

const NO_TXS_DESCRIPTION = 'No hay detalle de movimientos';

/**
 * Reads the statement table once the page has actually switched to `month`. Picking a month
 * reloads the table asynchronously, so a read taken too early sees the previous month's rows or
 * an empty table — which the caller would turn into wrong inserts and a wiped month. "Switched"
 * means: every row is dated inside `month` (or the bank's explicit no-transactions row is shown),
 * and two reads in a row agree.
 */
async function readStatementRows(page: Page, month: dayjs.Dayjs) {
  const read = () =>
    page.evaluate(() =>
      Array.from(
        document.querySelectorAll('#transactionTable1 tbody tr:not(.bel-table_row__neutral)'),
      ).map((tr) => ({
        date: tr.querySelector('td:nth-of-type(1)')?.textContent?.trim() ?? '',
        docNo: tr.querySelector('td:nth-of-type(2)')?.textContent?.trim() ?? '',
        description: tr.querySelector('td:nth-of-type(3)')?.textContent?.trim() ?? '',
        debit: (tr.querySelector('td:nth-of-type(4)')?.textContent?.trim() ?? '').replace(/,/g, ''),
        credit: (tr.querySelector('td:nth-of-type(5)')?.textContent?.trim() ?? '').replace(
          /[+,]/g,
          '',
        ),
      })),
    );
  const isForMonth = (rows: Awaited<ReturnType<typeof read>>) =>
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.description === NO_TXS_DESCRIPTION ||
        dayjs(row.date, 'DD/MM/YYYY', true).isSame(month, 'month'),
    );
  const deadline = Date.now() + 30_000;
  let previous: string | undefined;
  while (Date.now() < deadline) {
    const rows = await read();
    const snapshot = JSON.stringify(rows);
    if (isForMonth(rows) && snapshot === previous) {
      return rows;
    }
    previous = snapshot;
    await page.waitForTimeout(1000);
  }
  throw new Error(
    `BAC statement table never settled on ${month.format('YYYY-MM')} (still showing other dates or no rows)`,
  );
}

export async function bacScrape({
  bankKey,
  config,
  months,
  page,
  log,
}: {
  bankKey: string;
  config: z.infer<typeof bacSchema> & { auth: BankCredentials };
  months: dayjs.Dayjs[];
  page: Page;
  log: ScrapeLog;
}) {
  log.info(
    { country: config.country, months: months.map((m) => m.format('YYYY-MM')) },
    'scraping BAC transactions',
  );
  const createTxs: (typeof bankTx.$inferInsert)[] = [];
  const deleteTxIds: string[] = [];
  // running_balance_cents = the last row's "Balance" (in cents) on the current month, per account.
  const runningBalances: Record<string, number> = {};

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
    let accountScrapedTxs: (typeof bankTx.$inferInsert)[] = [];
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
      let latestBalance: { month: dayjs.Dayjs; cents: number } | undefined;
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
        const scrapedConfirmedTxs = (await readStatementRows(page, monthDayJs))
          .map((tx) => {
            if (tx.description === NO_TXS_DESCRIPTION) {
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
        // A real statement never loses every row of a month. Scraping none where rows are stored
        // means the page was read wrong — returning it would delete that month from the DB.
        const month = monthDayJs.format('YYYY-MM');
        if (
          scrapedConfirmedTxs.length === 0 &&
          accountCurrentTxs.some((t) => t.month === month && !t.reconcile)
        ) {
          throw new Error(
            `BAC account ${account.number}: scraped no transactions for ${month}, but the DB has some — refusing to delete them`,
          );
        }
        accountScrapedTxs.push(...scrapedConfirmedTxs);

        // Capture the ledger balance: the last data row's "Balance" column (td:6) — Saldo
        // disponible + Retenido, reconciled vs SUM(bank_tx). Taken from the latest month that has
        // rows; it only counts as the CURRENT balance if every month after it, through this one,
        // was also scraped (and so is known to be empty) — checked after the loop.
        if (scrapedConfirmedTxs.length > 0) {
          const lastBalance = await page.evaluate(() => {
            const rows = document.querySelectorAll(
              '#transactionTable1 tbody tr:not(.bel-table_row__neutral)',
            );
            const cell = rows[rows.length - 1]?.querySelector('td:nth-of-type(6)');
            return cell?.textContent?.trim() ?? null;
          });
          const dollars = lastBalance ? parseFloat(lastBalance.replace(/,/g, '')) : NaN;
          if (
            !Number.isNaN(dollars) &&
            (!latestBalance || monthDayJs.isAfter(latestBalance.month, 'month'))
          ) {
            latestBalance = { month: monthDayJs, cents: Math.round(dollars * 100) };
          }
        }
      }
      if (latestBalance) {
        const scraped = new Set(months.map((m) => m.format('YYYY-MM')));
        let covered = true;
        for (
          let m = latestBalance.month.add(1, 'month');
          !m.isAfter(dayjs(), 'month');
          m = m.add(1, 'month')
        ) {
          covered &&= scraped.has(m.format('YYYY-MM'));
        }
        if (covered) {
          runningBalances[bankAccountId] = latestBalance.cents;
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

      accountScrapedTxs = numberOccurrences(accountScrapedTxs);
      deleteTxIds.push(
        ...accountCurrentTxs
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
              occurrence: currentTx.occurrence,
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
