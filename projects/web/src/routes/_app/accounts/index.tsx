import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Header } from '~/components/layout/header';
import { Main } from '~/components/layout/main';
import { ThemeSwitch } from '~/components/theme-switch';
import { Register } from '~/components/register/register';
import { RegisterToolbar, type FilterPatch } from '~/components/register/register-toolbar';
import { registerSearchSchema } from '~/lib/filters';

export const Route = createFileRoute('/_app/accounts/')({
  component: AllAccounts,
  validateSearch: registerSearchSchema,
});

function AllAccounts() {
  // `highlight` is a view concern, not a filter: destructured out so it stays clear of the
  // React Query key, which is `filters`.
  const { highlight, ...filters } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // `replace` keeps filter fiddling out of the back-button history — otherwise clicking through
  // four presets means four presses of Back to leave the page.
  const onChange = (patch: FilterPatch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

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
        <RegisterToolbar filters={filters} onChange={onChange} />
        <Register filters={filters} showAccountColumn highlight={highlight} />
      </Main>
    </>
  );
}
