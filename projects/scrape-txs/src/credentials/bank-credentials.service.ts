import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { BankKey } from '~/bank-config/bank-keys';
import type { Config } from '~/bank-config/config-schema';
import { type BankCredentials, BwCli, parseBankCredentials } from './bitwarden';

/**
 * `scope` says how far a failure reaches: `session` means Bitwarden itself could not be opened, so
 * every bank of the call failed for the same reason; `item` means only this bank's item is broken.
 */
export type CredentialsResult =
  | { ok: true; credentials: BankCredentials }
  | { ok: false; scope: 'session' | 'item'; error: Error };

const BW_ENV = ['BW_CLIENTID', 'BW_CLIENTSECRET', 'BW_PASSWORD'] as const;

// Bi en Línea's third login value ("Código") is the item's `campoInstalacion` custom field.
const CODE_FIELD: Partial<Record<BankKey, string>> = { bancoIndustrialGt: 'campoInstalacion' };

@Injectable()
export class BankCredentialsService {
  // `bw` keeps one state dir: a second session locking it while the first still reads breaks the
  // first. So calls run one after another, however they arrive.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly bw: BwCli) {}

  /**
   * The credentials of every requested bank, from ONE Bitwarden session. Never rejects: a failure
   * is reported per bank, so one broken item cannot take the other banks down with it.
   */
  fetch(bankKeys: BankKey[], config: Config): Promise<Map<BankKey, CredentialsResult>> {
    const result = this.queue.then(() => this.fetchNow(bankKeys, config));
    this.queue = result.catch(() => {});
    return result;
  }

  private async fetchNow(
    bankKeys: BankKey[],
    config: Config,
  ): Promise<Map<BankKey, CredentialsResult>> {
    const results = new Map<BankKey, CredentialsResult>();
    if (bankKeys.length === 0) {
      return results;
    }
    const failSession = (error: unknown) => {
      for (const bankKey of bankKeys) {
        results.set(bankKey, { ok: false, scope: 'session', error: toError(error) });
      }
      return results;
    };

    let session: string;
    try {
      for (const name of BW_ENV) {
        if (!process.env[name]) {
          throw new Error(`Bitwarden: ${name} is not set`);
        }
      }
      const { status } = z
        .object({ status: z.string() })
        .parse(JSON.parse(await this.bw.run(['status'])));
      if (status === 'unauthenticated') {
        await this.bw.run(['login', '--apikey']);
      }
      session = await this.bw.run(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw']);
    } catch (error) {
      return failSession(error);
    }

    try {
      try {
        // `bw` reads a local cache; without a sync a password changed in the vault is not seen.
        await this.bw.run(['sync'], session);
      } catch (error) {
        return failSession(error);
      }
      for (const bankKey of bankKeys) {
        try {
          const item: unknown = JSON.parse(
            await this.bw.run(['get', 'item', config.banks[bankKey].bitwardenItemId], session),
          );
          const codeField = CODE_FIELD[bankKey];
          results.set(bankKey, {
            ok: true,
            credentials: parseBankCredentials(item, codeField ? { codeField } : {}),
          });
        } catch (error) {
          results.set(bankKey, { ok: false, scope: 'item', error: toError(error) });
        }
      }
      return results;
    } finally {
      await this.bw.run(['lock']).catch(() => {});
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
