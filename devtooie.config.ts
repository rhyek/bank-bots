import { defineConfig } from 'devtooie';

export default defineConfig({
  packages: [
    // @bank-bots/db (projects/db) is a source-only TS library (its `exports` point at src; no
    // build/emit) — consumers transpile it (scrape-txs via swc-node, the web app via Vite). It has
    // no dev process, so it isn't a devtooie package; the workspace link + package exports wire it.
    {
      name: 'scrape-txs',
      relativeDir: 'projects/scrape-txs',
      // One-shot scraper run straight with node (no file watching); after editing its
      // code, restart it. `builds` defaults to true, but there's no build/clean script,
      // so a rebuild is a no-op — restart re-runs node (swc-node re-transpiles).
      command: ['start', { watches: false }],
    },
  ],
});
