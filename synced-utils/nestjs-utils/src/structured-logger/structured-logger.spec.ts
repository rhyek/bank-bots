import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { StructuredLoggerService } from './structured-logger.service';

// Boots the example app as a real process and asserts on its real log output. Deliberately an
// integration test rather than unit tests: every bug this logger has had was in how pino, Nest's
// DI, and AsyncLocalStorage interact at runtime — none would have been caught by mocking them.
// A child process, not an in-process app, because pino writes straight to fd 1.

type LogLine = {
  msg?: string;
  context?: string;
  time?: number;
  pid?: number;
  hostname?: string;
  service?: string;
  orderId?: string;
  build?: { sha?: string };
  error?: { stack?: string };
  req?: {
    url?: string;
    tenantId?: string;
    headers?: Record<string, string>;
    body?: { keep?: number; creds?: { password?: string; user?: string } };
  };
};

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const lines: LogLine[] = [];
let output = '';
let app: ChildProcess;
let origin: string;

async function lineWhere(what: string, predicate: (line: LogLine) => boolean): Promise<LogLine> {
  for (const deadline = Date.now() + 8000; Date.now() < deadline; await sleep(20)) {
    const found = lines.find(predicate);
    if (found) {
      return found;
    }
    if (app.exitCode !== null) {
      break;
    }
  }
  throw new Error(`no log line: ${what}\n--- app output ---\n${output}`);
}

before(async () => {
  app = spawn(
    process.execPath,
    ['--import', '@swc-node/register/esm-register', 'example/structured-logger/main.ts'],
    { cwd: packageDir, env: { ...process.env, PORT: '0', LOG_LEVEL: 'debug' } },
  );
  app.stderr!.on('data', (chunk) => (output += chunk));
  createInterface({ input: app.stdout! }).on('line', (line) => {
    output += `${line}\n`;
    try {
      lines.push(JSON.parse(line) as LogLine);
    } catch {
      // Not a log line — kept in `output` for the failure message.
    }
  });

  const listening = await lineWhere(
    'listening',
    (l) => l.msg?.startsWith('listening on :') === true,
  );
  origin = `http://localhost:${listening.msg!.split(':')[1]}`;

  await fetch(`${origin}/status/health?token=SEKRIT&page=2`, {
    headers: { authorization: 'Bearer X', 'x-house-key': 'HK', 'x-request-id': 'r_1' },
  });
  await fetch(`${origin}/status/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creds: { password: 'PW', user: 'bob' }, keep: 1 }),
  });
});

after(() => {
  app.kill();
});

test('a line carries the injecting class as context, with no setContext call', async () => {
  const line = await lineWhere('health check', (l) => l.msg === 'health check');
  assert.equal(line.context, 'StatusController');
});

test("Nest's own logs come out structured", async () => {
  const line = await lineWhere('listening', (l) => l.msg?.startsWith('listening on :') === true);
  assert.equal(line.context, 'Bootstrap');
  assert.ok(!output.includes('[Nest]'), 'a framework line escaped in the console format');
});

test('request context lands on the line, with header and query credentials redacted', async () => {
  const line = await lineWhere('health check', (l) => l.msg === 'health check');
  assert.equal(line.req?.url, '/status/health?token=[redacted]&page=2');
  assert.equal(line.req?.headers?.authorization, '[redacted]');
  assert.equal(line.req?.headers?.['x-house-key'], '[redacted]');
  assert.equal(line.req?.headers?.['x-request-id'], 'r_1');
});

test('mixins and merged-in attributes land on the line', async () => {
  const line = await lineWhere('health check', (l) => l.msg === 'health check');
  assert.equal(line.build?.sha, 'dev');
  assert.equal(line.orderId, 'o_1');
});

test("pino's time, pid and hostname are left out by default; `base` adds static fields", async () => {
  const line = await lineWhere('health check', (l) => l.msg === 'health check');
  assert.equal('time' in line, false);
  assert.equal('pid' in line, false);
  assert.equal('hostname' in line, false);
  assert.equal(line.service, 'example');
});

test('`timestamp` and `base` bring time and pid back when asked for', () => {
  const script = `
    import { createPinoLogger } from '@rhyek/nestjs-utils';
    createPinoLogger({ timestamp: true, base: { pid: process.pid } }).info('opted in');
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--import', '@swc-node/register/esm-register', '--input-type=module', '--eval', script],
    { cwd: packageDir, encoding: 'utf8' },
  );
  const line = JSON.parse(stdout.trim().split('\n').at(-1)!) as LogLine;
  assert.equal(line.msg, 'opted in');
  assert.equal(typeof line.time, 'number');
  assert.equal(typeof line.pid, 'number');
  assert.equal('hostname' in line, false);
});

test('the request body is captured, with strip.json paths redacted and nothing else', async () => {
  const line = await lineWhere('echo received', (l) => l.msg === 'echo received');
  assert.deepEqual(line.req?.body, { creds: { password: '[redacted]', user: 'bob' }, keep: 1 });
});

test('redaction happens at emit: the handler still receives the real body', async () => {
  const response = await fetch(`${origin}/status/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creds: { password: 'PW' } }),
  });
  assert.deepEqual(await response.json(), { received: { creds: { password: 'PW' } } });
});

test('setRequestContext enriches every later line of the request', async () => {
  const line = await lineWhere('echo received', (l) => l.msg === 'echo received');
  assert.equal(line.req?.tenantId, 't_42');
});

test('an Error is serialized with its stack', async () => {
  const line = await lineWhere('demo error line', (l) => l.msg === 'demo error line');
  assert.match(line.error?.stack ?? '', /demo failure/);
});

test('createError logs, and its HttpException reaches the client with the given status', async () => {
  const response = await fetch(`${origin}/status/teapot`);
  assert.equal(response.status, 418);
  assert.equal(((await response.json()) as { message: string }).message, 'No coffee here');
  await lineWhere('teapot refused', (l) => l.msg === 'teapot refused');
});

// Never called — the assertions are the `@ts-expect-error`s, checked by `pnpm typecheck`. They
// prove an augmentation of '@rhyek/nestjs-utils' (the example's `orderId?: string`) really merges
// into `LogAttributes` through the package's re-exports rather than being silently ignored.
export function typeAssertions(logger: StructuredLoggerService): void {
  logger.info({ orderId: 'o_1' }, 'ok');
  // @ts-expect-error orderId was merged in as a string
  logger.info({ orderId: 123 }, 'wrong type for a known attribute');
  // @ts-expect-error error() requires an Error
  logger.error({ orderId: 'o_1' }, 'no error attached');
}
