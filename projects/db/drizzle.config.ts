import { defineConfig } from 'drizzle-kit';

// DATABASE_URL is provided via the environment (see the repo-root .env.local). devtooie injects
// it (`devtooie cmd -p db -c db:generate`); or source it first: `set -a; . ../../.env.local; set +a`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
