import { defineConfig } from 'vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// No Nitro. TanStack Start (v1.132+) builds to a Web `fetch` handler: `vite build` emits
// `dist/client` (static assets) + `dist/server/server.js` (the `{ fetch }` handler), which
// `server.ts` runs via srvx (the web-standard universal server TanStack Start itself builds on) on
// Node, also serving the static assets. Dropping Nitro keeps a boring, stable stack AND keeps
// node_modules deps as REAL runtime imports so the tracer (OTel / dd-trace) can auto-instrument the
// http server + outbound calls. `resolve.tsconfigPaths` makes the `~/` alias (from tsconfig paths)
// resolve at build.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
});
