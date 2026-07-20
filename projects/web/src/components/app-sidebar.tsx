import { Link } from '@tanstack/react-router';
import { useLayout } from '~/context/layout-provider';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '~/components/ui/sidebar';
import { NavGroup } from '~/components/layout/nav-group';
import type { NavGroup as NavGroupData } from '~/components/layout/types';

// Hardcoded for now — Task 5 replaces the Accounts group with the real account list.
const navGroups: NavGroupData[] = [
  {
    title: 'General',
    items: [
      { title: 'Overview', url: '/' },
      { title: 'Unmatched', url: '/unmatched' },
      { title: 'Payees', url: '/payees' },
    ],
  },
  {
    title: 'Accounts',
    items: [],
  },
];

// Single-user local app: no team switcher, no user menu — just the app name, and no
// SidebarFooter.
export function AppSidebar() {
  const { collapsible, variant } = useLayout();
  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              className="hover:bg-transparent active:bg-transparent"
            >
              <Link to="/" className="text-sm font-semibold">
                bank-bots
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => (
          <NavGroup key={group.title} {...group} />
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
