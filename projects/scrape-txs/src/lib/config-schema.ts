import { z } from 'zod';
import { AccountType } from './types';

export const configSchema = z.object({
  banks: z.object({
    bancoIndustrialGt: z.object({
      auth: z.object({
        code: z.string(),
        username: z.string(),
        password: z.string(),
      }),
      accounts: z.array(
        z.object({
          type: z.nativeEnum(AccountType),
          number: z.string(),
        })
      ),
    }),
  }),
  ynab: z.object({
    accessToken: z.string(),
    budgetId: z.string(),
    accountsMap: z.array(
      z.object({
        bankKey: z.string(),
        bankAccountNumber: z.string(),
        ynabAccountId: z.string(),
      })
    ),
  }),
});
