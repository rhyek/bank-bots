import { z } from 'zod';
import { AccountType } from './types';

export const bacSchema = z.object({
  // Credentials are not stored here: this is the id of the bank's login item in Bitwarden.
  bitwardenItemId: z.string(),
  country: z.string(),
  accounts: z.array(
    z.object({
      type: z.enum(['checking', 'creditcard']),
      number: z.string(),
    }),
  ),
});

export const configSchema = z.object({
  banks: z.object({
    bancoIndustrialGt: z.object({
      bitwardenItemId: z.string(),
      accounts: z.array(
        z.object({
          type: z.nativeEnum(AccountType),
          number: z.string(),
        }),
      ),
    }),
    bacGt: bacSchema,
    bacCr: bacSchema,
  }),
});

export type Config = z.infer<typeof configSchema>;
