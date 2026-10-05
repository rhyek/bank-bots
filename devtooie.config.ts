import { defineConfig } from 'devtooie';

export default defineConfig({
  infra: {
    'docker-compose': {
      services: {
        db: {
          enabled: ({ mode }) => mode === 'test',
          afterReady: async ({ run, fresh }) => {
            await run('pnpm', ['db:migrate'], { cwd: 'projects/db' });
            if (fresh) {
              await run('pnpm', ['db:seed:test'], { cwd: 'projects/db' });
            }
          },
        },
      },
    },
  },
  // Caddy (~/Dev/personal/workstation) forwards https://*.<ROOT_DOMAIN> here; devtooie routes by
  // subdomain, and answers with a status page for a package that is stopped or still starting.
  // No `defaultPackage`: the web app only accepts its own hostname (Vite's `allowedHosts`), so the
  // bare root domain stays a 404 that lists the hostnames that do exist.
  devReverseProxy: {
    rootDomain: ({ envs }) => envs.ROOT_DOMAIN,
    port: ({ envs }) => Number(envs.DEV_REVERSE_PROXY_PORT),
  },
  packageRootDir: 'projects',
  packages: {
    web: {
      port: ({ envs }) => Number(envs.WEB_PORT),
      subdomain: true,
      // A longer probe deadline than the 1500 ms default: the first request makes Vite compile the
      // SSR route, and an aborted probe shows up in the dev server as a dropped connection.
      healthcheck: { url: '/api/health', timeout: 5000 },
      urls: [{ label: 'home', url: '' }],
    },
    'scrape-txs': {
      command: ['start', { watches: false }],
      subdomain: true,
      port: ({ envs }) => Number(envs.SCRAPE_TXS_PORT),
      healthcheck: '/status/health',
      urls: [{ label: 'runs', url: '/scrape/runs' }],
    },
    'tx-payees': {
      command: ['start', { watches: false }],
      subdomain: true,
      port: ({ envs }) => Number(envs.TX_PAYEES_PORT),
      healthcheck: '/status/health',
      urls: [{ label: 'replica', url: '/replica/status' }],
    },
  },
});
