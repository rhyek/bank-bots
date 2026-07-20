import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import { TanStackDevtools } from '@tanstack/react-devtools';

import appCss from '~/styles.css?url';
import { Toaster } from '~/components/ui/sonner';

export const Route = createRootRoute({
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
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
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
