import { createFileRoute, Outlet, rootRouteId, useLoaderData } from '@tanstack/react-router';
import { SidebarProvider, SidebarInset } from '~/components/ui/sidebar';
import { LayoutProvider } from '~/context/layout-provider';
import { AppSidebar } from '~/components/app-sidebar';

export const Route = createFileRoute('/_app')({ component: AppLayout });

function AppLayout() {
  // Server-read cookie (see src/server/chrome.ts), fetched once by __root.tsx's loader — read here
  // via the root route id rather than re-fetching, so the sidebar's first paint already has the
  // right width instead of flashing open then snapping collapsed.
  const { sidebarOpen } = useLoaderData({ from: rootRouteId });

  return (
    <LayoutProvider>
      <SidebarProvider defaultOpen={sidebarOpen}>
        <AppSidebar />
        <SidebarInset>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </LayoutProvider>
  );
}
