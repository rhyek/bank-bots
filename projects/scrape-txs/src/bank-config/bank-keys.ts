import { z } from 'zod';

/** One bank key is one bank login. The single list every other module reads. */
export const BANK_KEYS = ['bancoIndustrialGt', 'bacGt', 'bacCr'] as const;

export const bankKeySchema = z.enum(BANK_KEYS);

export type BankKey = z.infer<typeof bankKeySchema>;

/**
 * The site each bank key logs in to. Two keys of one site are never scraped at the same moment: the
 * two BAC logins starting in the same second is what BAC's CDN answered with "Access Denied".
 */
export const BANK_SITES: Record<BankKey, string> = {
  bancoIndustrialGt: 'bi.com.gt',
  bacGt: 'baccredomatic.com',
  bacCr: 'baccredomatic.com',
};
