import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '~/bank-config/config-schema';
import { BankCredentialsService } from './bank-credentials.service';
import { bitwardenAppDataDir, type BwCli } from './bitwarden';

const config: Config = {
  banks: {
    bancoIndustrialGt: { bitwardenItemId: 'item-bi', accounts: [] },
    bacGt: { bitwardenItemId: 'item-gt', country: 'Guatemala', accounts: [] },
    bacCr: { bitwardenItemId: 'item-cr', country: 'Costa Rica', accounts: [] },
  },
};

const items: Record<string, unknown> = {
  'item-bi': {
    name: 'bi',
    login: { username: 'bi-user', password: 'bi-pw' },
    fields: [{ name: 'campoInstalacion', value: '777' }],
  },
  'item-gt': { name: 'gt', login: { username: 'gt-user', password: 'gt-pw' } },
  'item-cr': { name: 'cr', login: { username: 'cr-user', password: 'cr-pw' } },
};

/** A `bw` that records every command and can be told to fail one. */
function fakeBw(
  opts: { status?: string; fail?: (command: string) => boolean; delayMs?: number } = {},
) {
  const calls: string[] = [];
  const cli: BwCli = {
    async run(args, session) {
      const command = args.join(' ');
      calls.push(command);
      if (opts.delayMs) {
        await sleep(opts.delayMs);
      }
      if (opts.fail?.(command)) {
        throw new Error(`Bitwarden: \`bw ${args[0]}\` failed`);
      }
      switch (args[0]) {
        case 'status':
          return JSON.stringify({ status: opts.status ?? 'locked' });
        case 'unlock':
          return 'session-key';
        case 'get':
          assert.equal(session, 'session-key', 'get must run inside the unlocked session');
          return JSON.stringify(items[args[2]!]);
        default:
          return '';
      }
    },
  };
  return { cli, calls };
}

beforeEach(() => {
  // `process.env` is typed read-only here (process.env.d.ts).
  Object.assign(process.env, { BW_CLIENTID: 'id', BW_CLIENTSECRET: 'secret', BW_PASSWORD: 'pw' });
});

test('fetch: one Bitwarden session serves every requested bank key', async () => {
  const { cli, calls } = fakeBw();
  const result = await new BankCredentialsService(cli).fetch(['bacGt', 'bacCr'], config);

  assert.deepEqual(calls, [
    'status',
    'unlock --passwordenv BW_PASSWORD --raw',
    'sync',
    'get item item-gt',
    'get item item-cr',
    'lock',
  ]);
  assert.deepEqual(result.get('bacGt'), {
    ok: true,
    credentials: { username: 'gt-user', password: 'gt-pw' },
  });
  assert.deepEqual(result.get('bacCr'), {
    ok: true,
    credentials: { username: 'cr-user', password: 'cr-pw' },
  });
});

test('fetch: Banco Industrial also gets its login code from the item', async () => {
  const { cli } = fakeBw();
  const result = await new BankCredentialsService(cli).fetch(['bancoIndustrialGt'], config);
  assert.deepEqual(result.get('bancoIndustrialGt'), {
    ok: true,
    credentials: { username: 'bi-user', password: 'bi-pw', code: '777' },
  });
});

test('fetch: logs in first when the CLI is unauthenticated', async () => {
  const { cli, calls } = fakeBw({ status: 'unauthenticated' });
  await new BankCredentialsService(cli).fetch(['bacGt'], config);
  assert.deepEqual(calls.slice(0, 3), [
    'status',
    'login --apikey',
    'unlock --passwordenv BW_PASSWORD --raw',
  ]);
});

test('fetch: one item failing fails only its bank, and the vault is still locked', async () => {
  const { cli, calls } = fakeBw({ fail: (command) => command === 'get item item-gt' });
  const result = await new BankCredentialsService(cli).fetch(['bacGt', 'bacCr'], config);

  const gt = result.get('bacGt')!;
  assert.equal(gt.ok, false);
  assert.equal(gt.ok === false && gt.scope, 'item');
  assert.equal(result.get('bacCr')!.ok, true);
  assert.equal(calls.at(-1), 'lock');
});

test('fetch: a session failure fails every requested bank with the same error', async () => {
  const { cli } = fakeBw({ fail: (command) => command.startsWith('unlock') });
  const result = await new BankCredentialsService(cli).fetch(['bacGt', 'bacCr'], config);

  for (const bankKey of ['bacGt', 'bacCr'] as const) {
    const r = result.get(bankKey)!;
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.scope, 'session');
    assert.match(r.ok === false ? r.error.message : '', /bw unlock/);
  }
});

test('fetch: a missing BW_* variable is a session failure, before any bw command', async () => {
  Reflect.deleteProperty(process.env, 'BW_PASSWORD');
  const { cli, calls } = fakeBw();
  const result = await new BankCredentialsService(cli).fetch(['bacGt'], config);

  const r = result.get('bacGt')!;
  assert.equal(r.ok === false && r.scope, 'session');
  assert.match(r.ok === false ? r.error.message : '', /BW_PASSWORD is not set/);
  assert.deepEqual(calls, []);
});

test('fetch: two overlapping calls never interleave their bw commands', async () => {
  const { cli, calls } = fakeBw({ delayMs: 2 });
  const service = new BankCredentialsService(cli);
  await Promise.all([service.fetch(['bacGt'], config), service.fetch(['bacCr'], config)]);

  const session = ['status', 'unlock --passwordenv BW_PASSWORD --raw', 'sync'];
  assert.deepEqual(calls, [
    ...session,
    'get item item-gt',
    'lock',
    ...session,
    'get item item-cr',
    'lock',
  ]);
});

test('fetch: a failed call does not block the next one', async () => {
  const failing = fakeBw({ fail: (command) => command === 'sync' });
  const service = new BankCredentialsService(failing.cli);
  await service.fetch(['bacGt'], config);
  const again = await service.fetch(['bacGt'], config);
  assert.equal(again.get('bacGt')!.ok, false);
  assert.equal(failing.calls.filter((c) => c === 'status').length, 2);
});

test('the bw CLI state lives in storage/bitwarden-cli at the workspace root', () => {
  // Moving this file must not move the state dir: a fresh one makes `bw` log in again as a new
  // device.
  assert.equal(path.basename(bitwardenAppDataDir), 'bitwarden-cli');
  const root = path.resolve(bitwardenAppDataDir, '..', '..');
  assert.equal(path.basename(path.dirname(bitwardenAppDataDir)), 'storage');
  assert.ok(
    fs.existsSync(path.join(root, 'pnpm-workspace.yaml')),
    `${root} is not the workspace root`,
  );
});
