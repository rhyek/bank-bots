import { defineConfig } from 'devtooie';

export default defineConfig({
  packages: [
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
