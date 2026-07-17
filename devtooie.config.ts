import { defineConfig } from 'devtooie';

export default defineConfig({
  packages: [
    // @bank-bots/db (projects/db) is a source-only TS library (its `exports` point at src; no
    // build/emit) — consumers transpile it (scrape-txs via swc-node, the web app via Vite). It has
    // no dev process, so it isn't a devtooie package; the workspace link + package exports wire it.
    {
      name: 'scrape-txs',
      relativeDir: 'projects/scrape-txs',
      selectable: false,
    },
    {
      name: 'ai-agent',
      relativeDir: 'projects/ai-agent',
      command: ['start', { watches: false }],
      port: 3001,
      healthcheck: 'http://localhost:$port/status/health',
    },
  ],
});
