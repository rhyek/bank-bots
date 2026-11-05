import { rootRouteId, useLoaderData } from '@tanstack/react-router';
import { AppSidebar } from '~/components/app-sidebar';
import { SidebarProvider, SidebarInset } from '~/components/ui/sidebar';
import { LayoutProvider } from '~/context/layout-provider';

// The sidebar + content frame every page sits in. The `_app` layout route renders it around its
// <Outlet />; the root route's not-found page renders it too, because a URL that matches nothing
// under `_app` never reaches that layout.
export function AppShell({ children }: { children: React.ReactNode }) {
  // Server-read cookie (see src/server/chrome.ts), fetched once by __root.tsx's loader — read here
  // via the root route id rather than re-fetching, so the sidebar's first paint already has the
  // right width instead of flashing open then snapping collapsed.
  const { sidebarOpen } = useLoaderData({ from: rootRouteId });

  return (
    <LayoutProvider>
      <SidebarProvider defaultOpen={sidebarOpen}>
        <AppSidebar />
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
    </LayoutProvider>
  );
}
