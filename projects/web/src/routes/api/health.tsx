import { createFileRoute } from '@tanstack/react-router';

// Liveness endpoint. devtooie polls it to decide when the dev server is up
// (see the `healthcheck` field on this package's entry in devtooie.config.ts).
// Intentionally does NOT touch the database, so a DB outage doesn't read as
// "the web app failed to start".
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => Response.json({ status: 'ok' }),
    },
  },
});
