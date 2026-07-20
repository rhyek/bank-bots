import { defineConfig } from 'vitest/config';

// Mirrors vite.config.ts's `resolve.tsconfigPaths` so the `~/` alias (tsconfig `paths`) resolves
// under vitest too, instead of hand-writing a separate alias map that could drift from tsconfig.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Every test file here queries the SAME real database (there is no test DB). Vitest runs files in
  // parallel workers by default, so a file that inserts or deletes a row could change the row count
  // another file is mid-assertion on (e.g. the keyset "every row exactly once" walk). Run files
  // serially so each has the database to itself for its duration.
  test: { fileParallelism: false },
});
