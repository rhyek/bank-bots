import { useState } from 'react';
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import { TanStackDevtools } from '@tanstack/react-devtools';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import appCss from '~/styles.css?url';
import { Toaster } from '~/components/ui/sonner';
import { ThemeProvider } from '~/context/theme-provider';
import { getChromeCookies } from '~/server/chrome';

export const Route = createRootRoute({
  // The one loader in the app that fetches — it's layout state (theme + sidebar width), read
  // server-side so first paint already reflects it instead of flashing the default and correcting
  // itself after hydration.
  loader: () => getChromeCookies(),
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        // maximum-scale=1 stops iOS Safari from auto-zooming into focused inputs
        // (it does that whenever an input's font-size is < 16px, e.g. our 13px fields).
        content: 'width=device-width, initial-scale=1, maximum-scale=1',
      },
      {
        title: 'bank-bots',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
  // Read/loader + render errors surface here; server-fn MUTATION errors are toasted globally in
  // src/start.ts. Swap this for your own shell-wrapped error UI.
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        {error instanceof Error ? error.message : 'Unexpected error'}
      </p>
    </div>
  ),
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const { theme } = Route.useLoaderData();
  // Creating the QueryClient in useState (not module scope) matters: a module-level client on the
  // server would be shared across every request.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The register is immutable history; refetching on every window focus is pure noise.
            refetchOnWindowFocus: false,
            staleTime: 30_000,
          },
        },
      }),
  );

  return (
    // suppressHydrationWarning: the no-flash script below mutates this element's class list
    // directly (before hydration), which React would otherwise flag as a hydration mismatch since
    // our JSX never renders a className here. It's scoped to this one element only — React still
    // fully validates every other attribute and the rest of the tree.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Blocking (no defer/async/module) so it runs before first paint. Only needed for
            theme === 'system': SSR can't call matchMedia, so ThemeProvider renders a 'light'
            fallback server-side (see theme-provider.tsx) and applies the real preference in a
            client useEffect — which runs after paint. This duplicates that same resolution
            synchronously, before the browser paints, so a dark-OS user never sees a light flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=${JSON.stringify(theme)};var r=t==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;document.documentElement.classList.add(r);}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider defaultTheme={theme}>{children}</ThemeProvider>
        </QueryClientProvider>
        <Toaster />
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
