import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// No Nitro. TanStack Start (v1.132+) builds to a Web `fetch` handler: `vite build` emits
// `dist/client` (static assets) + `dist/server/server.js` (the `{ fetch }` handler), which
// `server.ts` runs via srvx (the web-standard universal server TanStack Start itself builds on) on
// Node, also serving the static assets. Dropping Nitro keeps a boring, stable stack AND keeps
// node_modules deps as REAL runtime imports rather than an opaque bundle.
// `resolve.tsconfigPaths` makes the `~/` alias (from tsconfig paths) resolve at build.

// The dev server binds `process.env.PORT` and nothing else — devtooie injects it (WEB_PORT in
// .env.development). No fallback on purpose: Vite would otherwise quietly bind 5173, an unallocated
// port — see ~/Dev/CLAUDE.md. `vite build` never binds, so it is exempt.
function devPort(): number {
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port)) {
    throw new Error('PORT is not set — run the dev server through devtooie (`devtooie -p web`)');
  }
  return port;
}

// devtooie routes this app through its dev reverse proxy behind a TLS terminator, so the browser
// reaches it at PUBLIC_ORIGIN (https://web.<root domain>, injected next to PORT): Vite must allow
// that Host, and its HMR websocket must ride the same TLS connection (port 443) instead of dialling
// the Vite port directly. Absent PUBLIC_ORIGIN nothing changes.
function publicOrigin() {
  const origin = process.env.PUBLIC_ORIGIN;
  if (!origin) {
    return {};
  }
  const url = new URL(origin);
  return {
    allowedHosts: [url.hostname],
    hmr: { clientPort: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) },
  };
}

export default defineConfig(({ command, isPreview }) => ({
  resolve: { tsconfigPaths: true },
  plugins: [
    // Every one of these sub-features defaults to ON, and together they made `vite dev` unusable
    // here: the dev server wrote a 100 MB log in minutes and then exited 1.
    //
    //  - consolePiping mirrors the browser console into the terminal. This app's client is a
    //    constant stream of HMR + query chatter, so it pipes without pause.
    //  - enhancedLogs rewrites each of those lines to embed a clickable
    //    `http://localhost:<port>/__tsd/open-source?source=<abs-path>` link. Server functions are
    //    compiled once per environment (client / ssr / serverfn-split), so a single
    //    `createServerFn` produced several of these per reload — most of the volume.
    //  - injectSource stamps `data-tsd-source="/src/routes/…"` onto every rendered element, which
    //    also showed up in the SSR HTML.
    //
    // The devtools PANEL still works: it talks over the event bus, which stays enabled. Only the
    // terminal-logging and DOM-stamping extras are off.
    devtools({
      consolePiping: { enabled: false },
      enhancedLogs: { enabled: false },
      injectSource: { enabled: false },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  // `!isPreview`: a Vite preview server also resolves this config with command 'serve', and has
  // no use for the dev port.
  server:
    command === 'serve' && !isPreview
      ? { port: devPort(), strictPort: true, ...publicOrigin() }
      : undefined,
}));
