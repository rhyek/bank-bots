import type dayjs from 'dayjs';
import ynab from 'ynab';
import type { BiConfig } from '../banco-industrial';
import { supabase } from '../database';
import type { YnabConfig } from '../ynab';
import Decimal from 'decimal.js';

export async function bancoIndustrialFindCorrespondingYnabTxs({
  biConfig: { auth, accounts },
  ynabConfig,
  months,
}: {
  biConfig: BiConfig;
  ynabConfig: YnabConfig;
  months: dayjs.Dayjs[];
}) {
  const api = new ynab.API(ynabConfig.accessToken);
  await Promise.all(
    months.map(async (month) => {
      const ynabTxs = (
        await api.transactions.getTransactionsByAccount(
          ynabConfig.budgetId,
          ynabConfig.accountsMap.find(
            (accountMap) =>
              accountMap.bankKey === 'bancoIndustrialGt' &&
              accountMap.bankAccountNumber === accounts[0].number
          )!.ynabAccountId,
          month.startOf('month').toISOString()
        )
      ).data.transactions.filter(
        (tx) => tx.date.slice(0, 7) === month.format('YYYY-MM')
      );

      // console.log({ ynabTxs });

      const response = await supabase
        .from('banco_industrial_gt_txs')
        .select()
        .eq('month', month.format('YYYY-MM'));
      if (response.error) {
        throw new Error(
          `Error selecting banco_industrial_gt_txs: ${JSON.stringify(
            response.error
          )}`
        );
      }
      const { data: bankTxs } = response;

      for (const bankTx of bankTxs) {
        const index = ynabTxs.findIndex((tx) =>
          tx.memo?.match(new RegExp(`[^\\d]${bankTx.doc_no}\\b`))
        );
        if (index > -1) {
          const ynabTx = ynabTxs.splice(index, 1)[0];
          const ynabAmount = new Decimal(ynabTx.amount).div(1000).toNumber();
          if (ynabAmount !== bankTx.amount) {
            console.error({
              bankTx,
              ynabTx: {
                amount: ynabAmount,
              },
            });
          }
        } else {
          console.error({
            bankTx,
            ynabTx: null,
          });
        }
      }
      // console.log({ bankTxs });
    })
  );
}
