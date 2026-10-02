import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// The scraper logs `bw` in as its own Bitwarden account, so its CLI state lives in the repo
// (gitignored) rather than the OS-wide default dir, which may hold a personal login.
const appDataDir =
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

async function bw(args: string[], session?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('bw', [...args, '--nointeraction'], {
      env: {
        ...process.env,
        BITWARDENCLI_APPDATA_DIR: appDataDir,
        // The session key goes through the environment, never argv (visible in `ps`).
        ...(session ? { BW_SESSION: session } : {}),
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`Bitwarden: \`bw ${args[0]}\` failed: ${stderr || (error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * Fetches a bank's credentials from Bitwarden. Syncs first — `bw` reads a local cache, so
 * without it a password changed in the vault would not be seen.
 */
export async function fetchBankCredentials(
  itemId: string,
  opts: { codeField?: string } = {},
): Promise<BankCredentials> {
  for (const name of ['BW_CLIENTID', 'BW_CLIENTSECRET', 'BW_PASSWORD'] as const) {
    if (!process.env[name]) {
      throw new Error(`Bitwarden: ${name} is not set`);
    }
  }
  const { status } = z.object({ status: z.string() }).parse(JSON.parse(await bw(['status'])));
  if (status === 'unauthenticated') {
    await bw(['login', '--apikey']);
  }
  const session = await bw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw']);
  try {
    await bw(['sync'], session);
    const item: unknown = JSON.parse(await bw(['get', 'item', itemId], session));
    return parseBankCredentials(item, opts);
  } finally {
    await bw(['lock']).catch(() => {});
  }
}
