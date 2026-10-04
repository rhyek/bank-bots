import { z } from 'zod';

/** One bank key is one bank login. The single list every other module reads. */
export const BANK_KEYS = ['bancoIndustrialGt', 'bacGt', 'bacCr'] as const;

export const bankKeySchema = z.enum(BANK_KEYS);

export type BankKey = z.infer<typeof bankKeySchema>;
