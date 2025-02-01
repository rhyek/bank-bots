import { z } from 'zod';
import { AccountType } from './types';

export const bacSchema = z.object({
  auth: z.object({
    username: z.string(),
    password: z.string(),
  }),
  country: z.string(),
  accounts: z.array(
    z.object({
      type: z.enum(['checking', 'creditcard']),
      number: z.string(),
    })
  ),
});

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
    bacGt: bacSchema,
    bacCr: bacSchema,
  }),
});
