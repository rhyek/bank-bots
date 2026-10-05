import { defineConfig } from 'vitest/config';

// Mirrors vite.config.ts's `resolve.tsconfigPaths` so the `~/` alias (tsconfig `paths`) resolves
// under vitest too, instead of hand-writing a separate alias map that could drift from tsconfig.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // Refuses to run anywhere but test mode against the local test database: see the file.
    setupFiles: ['./src/test/require-test-database.ts'],
    // Every test file here queries the SAME test database. Vitest runs files in parallel workers
    // by default, so a file that inserts or deletes a row could change the row count another file
    // is mid-assertion on (e.g. the keyset "every row exactly once" walk). Run files serially so
    // each has the database to itself for its duration.
    fileParallelism: false,
  },
});
