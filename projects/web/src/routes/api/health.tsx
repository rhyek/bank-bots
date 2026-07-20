import { createFileRoute } from '@tanstack/react-router';

// Liveness/readiness endpoint for Kubernetes probes. Intentionally does NOT
// touch the DB so the pod stays "live" while the DB reconnects.
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => Response.json({ status: 'ok' }),
    },
  },
});
