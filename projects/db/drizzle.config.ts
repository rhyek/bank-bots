import { defineConfig } from 'drizzle-kit';

// DATABASE_URL is provided via the environment, by devtooie: from the repo root,
// `pnpm devtooie cmd -- pnpm -C projects/db db:generate` (development mode: the real database, from
// .env.development.local) or `pnpm devtooie --mode test cmd -- …` (the local test database).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
