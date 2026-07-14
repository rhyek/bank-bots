import { defineConfig } from 'drizzle-kit';

// DATABASE_URL is provided via the environment (see .env.local). Source it before running
// drizzle-kit commands, e.g. `set -a; . ./.env.local; set +a; pnpm drizzle-kit generate`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
