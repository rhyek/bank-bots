import { defineConfig } from 'vite';
import { devtools } from '@tanstack/devtools-vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// No Nitro. TanStack Start (v1.132+) builds to a Web `fetch` handler: `vite build` emits
// `dist/client` (static assets) + `dist/server/server.js` (the `{ fetch }` handler), which
// `server.ts` runs via srvx (the web-standard universal server TanStack Start itself builds on) on
// Node, also serving the static assets. Dropping Nitro keeps a boring, stable stack AND keeps
// node_modules deps as REAL runtime imports rather than an opaque bundle.
// `resolve.tsconfigPaths` makes the `~/` alias (from tsconfig paths) resolve at build.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    // Every one of these sub-features defaults to ON, and together they made `vite dev` unusable
    // here: the dev server wrote a 100 MB log in minutes and then exited 1.
    //
    //  - consolePiping mirrors the browser console into the terminal. This app's client is a
    //    constant stream of HMR + query chatter, so it pipes without pause.
    //  - enhancedLogs rewrites each of those lines to embed a clickable
    //    `http://localhost:3002/__tsd/open-source?source=<abs-path>` link. Server functions are
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
});
