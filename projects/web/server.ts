// Production server. srvx — the web-standard universal server TanStack Start already builds on —
// runs the app's Web `fetch` handler on Node and serves dist/client (MIME, path-traversal guard,
// range/compression). No hand-rolled node↔fetch bridge, no static/MIME code. Server-fn CSRF/origin
// is handled in src/start.ts. Node (≥22.18) strips the TS at load.
//
// Run via:  node server.ts
//
// This app ships no tracer — see "Instrumentation" in CLAUDE.md for why. Deps are still REAL
// runtime imports rather than a bundle, so adding one later needs no build change.
import { serve, type ServerMiddleware } from 'srvx';
import { serveStatic } from 'srvx/static';
// @ts-expect-error — a `vite build` artifact under dist/; it has no type declarations.
import handler from './dist/server/server.js';

// srvx/static has no cache option; Vite's /assets are content-hashed, so mark them immutable.
const immutableAssets: ServerMiddleware = async (req, next) => {
  const res = await next();
  if (new URL(req.url).pathname.startsWith('/assets/')) {
    res.headers.set('cache-control', 'public, max-age=31536000, immutable');
  }
  return res;
};

// srvx logs its own "Listening on…" banner and installs graceful-shutdown handlers.
serve({
  port: Number(process.env.PORT) || 3000,
  hostname: process.env.HOST || '0.0.0.0',
  middleware: [immutableAssets, serveStatic({ dir: 'dist/client' })],
  fetch: handler.fetch,
});
