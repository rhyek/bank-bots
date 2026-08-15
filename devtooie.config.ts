import { defineConfig } from 'devtooie';

export default defineConfig({
  // Keyed by package name — the key is the name, so there's no `name` field.
  packages: {
    // @bank-bots/db (projects/db) is a source-only TS library (its `exports` point at src; no
    // build/emit) — consumers transpile it (scrape-txs via swc-node, the web app via Vite). It has
    // no dev process, so it isn't a devtooie package; the workspace link + package exports wire it.
    'scrape-txs': {
      relativeDir: 'projects/scrape-txs',
      selectable: false,
    },
    'tx-payees': {
      relativeDir: 'projects/tx-payees',
      command: ['start', { watches: false }],
      port: 3001,
      // A callback over the resolved `port`, not `$port` — devtooie does no string
      // interpolation, so the URL can't drift from the port the process was handed.
      healthcheck: ({ port }) => `http://localhost:${port}/status/health`,
    },
    web: {
      relativeDir: 'projects/web',
      // Bare-string form — devtooie's tuple `command` form requires a 2-element
      // `[name, options]` (a lone `['dev']` fails schema validation); `'dev'` resolves to the
      // same defaults (`watches: true, builds: true, cleans: false`), matching `vite dev`'s own
      // hot-reload/watch behavior.
      command: 'dev',
      port: 3002,
      healthcheck: ({ port }) => `http://localhost:${port}/api/health`,
    },
  },
});
