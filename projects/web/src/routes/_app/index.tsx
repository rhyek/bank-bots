import { createFileRoute } from '@tanstack/react-router';
import { Header } from '~/components/layout/header';
import { Main } from '~/components/layout/main';
import { ThemeSwitch } from '~/components/theme-switch';

export const Route = createFileRoute('/_app/')({ component: Overview });

// Placeholder leaf so the route tree has something to render under the _app shell. Task 4+ gives
// this real data. ThemeSwitch lives here (not in _app.tsx) so it's per-page, like Header/Main —
// future pages compose their own Header the same way.
function Overview() {
  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Overview</h1>
        <div className="ms-auto">
          <ThemeSwitch />
        </div>
      </Header>
      <Main>
        <p className="text-muted-foreground text-sm">Coming soon.</p>
      </Main>
    </>
  );
}
