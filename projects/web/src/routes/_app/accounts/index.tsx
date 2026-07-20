import { createFileRoute } from '@tanstack/react-router';
import { Header } from '~/components/layout/header';
import { Main } from '~/components/layout/main';
import { ThemeSwitch } from '~/components/theme-switch';
import { Register } from '~/components/register/register';
import type { TxFilters } from '~/lib/filters';

export const Route = createFileRoute('/_app/accounts/')({ component: AllAccounts });

// Hardcoded until Task 8 reads the filters off the URL search params.
const filters: TxFilters = { window: 'all' };

function AllAccounts() {
  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">All Accounts</h1>
        <div className="ms-auto">
          <ThemeSwitch />
        </div>
      </Header>
      {/* The register owns the only scrollbar on this page: the header is a fixed 4rem, so pinning
          Main to the rest of the viewport keeps the body from scrolling behind a list that already
          scrolls itself. */}
      <Main fixed fluid className="h-[calc(100svh-4rem)]">
        <Register filters={filters} showAccountColumn />
      </Main>
    </>
  );
}
