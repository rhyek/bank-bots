// Loaded before every test file (vitest.config.ts `setupFiles`).
//
// These tests write to the database, and assert figures that only the test seed has
// (projects/db/seed/test-data.ts). So they run in test mode, against the local test database, or
// not at all — never against the real one, which is what DATABASE_URL means in development mode.
//
//   pnpm devtooie --mode test infra up            # start it, migrate (and seed it if new)
//   pnpm devtooie --mode test cmd -p web -c test
const mode = process.env.DEVTOOIE_MODE;
const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : undefined;

if (mode !== 'test' || (host !== 'localhost' && host !== '127.0.0.1')) {
  throw new Error(
    `The web tests only run against the local test database ` +
      `(DEVTOOIE_MODE=${mode ?? 'unset'}, database host ${host ?? 'unset'}). Run them with:\n` +
      `  pnpm devtooie --mode test infra up && pnpm devtooie --mode test cmd -p web -c test`,
  );
}
