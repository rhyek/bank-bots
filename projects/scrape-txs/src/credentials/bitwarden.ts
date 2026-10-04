import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// The scraper logs `bw` in as its own Bitwarden account, so its CLI state lives in the repo
// (gitignored) rather than the OS-wide default dir, which may hold a personal login. The path is
// `<workspace root>/storage/bitwarden-cli`; a spec pins it, because a moved file that resolved a
// fresh dir would make `bw` log in again as a new device.
export const bitwardenAppDataDir =
  process.env.BITWARDENCLI_APPDATA_DIR ??
  path.resolve(import.meta.dirname, '../../../../storage/bitwarden-cli');

const itemSchema = z.object({
  name: z.string(),
  login: z
    .object({
      username: z.string().nullish(),
      password: z.string().nullish(),
    })
    .nullish(),
  fields: z.array(z.object({ name: z.string().nullish(), value: z.string().nullish() })).nullish(),
});

export type BankCredentials = { username: string; password: string; code?: string };

/**
 * Maps a Bitwarden login item to bank credentials. Always the item's own username/password —
 * custom fields are only read for `codeField`. Errors name the item, never a value.
 */
export function parseBankCredentials(
  rawItem: unknown,
  opts: { codeField?: string } = {},
): BankCredentials {
  const item = itemSchema.parse(rawItem);
  const username = item.login?.username;
  const password = item.login?.password;
  if (!username) {
    throw new Error(`Bitwarden item "${item.name}" has no username`);
  }
  if (!password) {
    throw new Error(`Bitwarden item "${item.name}" has no password`);
  }
  if (!opts.codeField) {
    return { username, password };
  }
  const code = item.fields?.find((f) => f.name === opts.codeField)?.value;
  if (!code) {
    throw new Error(`Bitwarden item "${item.name}" has no "${opts.codeField}" field`);
  }
  return { username, password, code };
}

/** Runs one `bw` command. The seam a spec replaces; everything else here is plain logic. */
export abstract class BwCli {
  abstract run(args: string[], session?: string): Promise<string>;
}

@Injectable()
export class BwCliProcess extends BwCli {
  async run(args: string[], session?: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('bw', [...args, '--nointeraction'], {
        env: {
          ...process.env,
          BITWARDENCLI_APPDATA_DIR: bitwardenAppDataDir,
          // The session key goes through the environment, never argv (visible in `ps`).
          ...(session ? { BW_SESSION: session } : {}),
        },
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(
        `Bitwarden: \`bw ${args[0]}\` failed: ${stderr || (error as Error).message}`,
        {
          cause: error,
        },
      );
    }
  }
}
