import { ignorePatterns, oxfmtConfig } from '@rhyek/oxc-config/oxfmt';
import { defineConfig } from 'oxfmt';

export default defineConfig({
  ...oxfmtConfig,
  ignorePatterns: [
    ...ignorePatterns,
    // Build output.
    '**/dist/**',
    '**/build/**',
    // Generated — never hand-formatted.
    '**/lib/db/codegen.d.ts',
    'projects/web/src/routeTree.gen.ts',
    // drizzle-kit output.
    'projects/db/drizzle/**',
    // Vendored shadcn/ui CLI output, kept as the CLI writes it.
    'projects/web/src/components/ui/**',
  ],
});
