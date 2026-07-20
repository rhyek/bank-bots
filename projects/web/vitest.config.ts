import { defineConfig } from 'vitest/config';

// Mirrors vite.config.ts's `resolve.tsconfigPaths` so the `~/` alias (tsconfig `paths`) resolves
// under vitest too, instead of hand-writing a separate alias map that could drift from tsconfig.
export default defineConfig({
  resolve: { tsconfigPaths: true },
});
