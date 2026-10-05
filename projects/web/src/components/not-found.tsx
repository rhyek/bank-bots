import { Link } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';
import { Header } from '~/components/layout/header';
import { Main } from '~/components/layout/main';
import { ThemeSwitch } from '~/components/theme-switch';

// The not-found page, for a URL no route matches and for any `notFound()` a loader throws. The
// response keeps its 404 status. It is page content, so it must render inside <AppShell>: as the
// router's `defaultNotFoundComponent` (src/router.tsx) it lands in the `_app` layout's <Outlet />,
// and the root route wraps it in the shell itself (src/routes/__root.tsx).
export function NotFound() {
  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Page not found</h1>
        <div className="ms-auto">
          <ThemeSwitch />
        </div>
      </Header>
      <Main>
        <p className="text-muted-foreground text-sm">Nothing lives at this address.</p>
        <Button asChild variant="outline" size="sm" className="mt-6">
          <Link to="/">Back to transactions</Link>
        </Button>
      </Main>
    </>
  );
}
