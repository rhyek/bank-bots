import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { LinkProps } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { useLayout } from '~/context/layout-provider';
import { accountsQueryOptions } from '~/lib/queries';
import { formatCents } from '~/lib/format';
import type { AccountSummary } from '~/server/queries/accounts';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '~/components/ui/sidebar';
import { Skeleton } from '~/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { NavGroup } from '~/components/layout/nav-group';
import type { NavGroup as NavGroupData } from '~/components/layout/types';
import { RenameAccountDialog } from '~/components/rename-account-dialog';

// The route tree doesn't have `/accounts` or `/accounts/$accountId` yet (a later task adds them),
// so links to them go through this escape hatch — same trick as NavLink/NavCollapsible in
// ~/components/layout/types — rather than a hard TS error on an unregistered route string.
type Href = LinkProps['to'] | (string & {});

const ALL_ACCOUNTS_HREF: Href = '/accounts';
function accountHref(accountId: string): Href {
  return `/accounts/${accountId}`;
}

// Fixed nav — Task 5 only replaces the (previously empty) Accounts group below.
const generalNavGroup: NavGroupData = {
  title: 'General',
  items: [
    { title: 'Overview', url: '/' },
    { title: 'Unmatched', url: '/unmatched' },
    { title: 'Payees', url: '/payees' },
  ],
};

// Display names for each `bankKey` — only these three exist. Put here (not derived) since the
// mapping is a presentation choice, not data.
const BANK_LABELS: Record<string, string> = {
  bacGt: 'BAC GT',
  bacCr: 'BAC CR',
  bancoIndustrialGt: 'BANCO INDUSTRIAL',
};

function groupByBank(accounts: AccountSummary[]): [string, AccountSummary[]][] {
  const groups = new Map<string, AccountSummary[]>();
  for (const account of accounts) {
    const group = groups.get(account.bankKey);
    if (group) {
      group.push(account);
    } else {
      groups.set(account.bankKey, [account]);
    }
  }
  return [...groups.entries()];
}

// Single-user local app: no team switcher, no user menu — just the app name, and no
// SidebarFooter.
export function AppSidebar() {
  const { collapsible, variant } = useLayout();
  const { data: accounts, isPending } = useQuery(accountsQueryOptions());
  const [renamingAccount, setRenamingAccount] = useState<AccountSummary | null>(null);

  const totalCents = accounts?.reduce((sum, account) => sum + account.balanceCents, 0) ?? 0;
  const bankGroups = accounts ? groupByBank(accounts) : [];

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
        <NavGroup {...generalNavGroup} />
        <SidebarGroup>
          <SidebarGroupLabel>Accounts</SidebarGroupLabel>
          {isPending ? (
            <AccountsSkeleton />
          ) : (
            <>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild>
                    <Link to={ALL_ACCOUNTS_HREF}>
                      <span>All Accounts</span>
                      <span className="ms-auto text-xs font-medium tabular-nums">
                        {formatCents(totalCents)}
                      </span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
              {bankGroups.map(([bankKey, bankAccounts]) => (
                <div key={bankKey}>
                  <SidebarGroupLabel className="mt-1">
                    {BANK_LABELS[bankKey] ?? bankKey}
                  </SidebarGroupLabel>
                  <SidebarMenu>
                    {bankAccounts.map((account) => (
                      <AccountMenuItem
                        key={account.id}
                        account={account}
                        onRename={setRenamingAccount}
                      />
                    ))}
                  </SidebarMenu>
                </div>
              ))}
            </>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
      <RenameAccountDialog
        account={renamingAccount}
        open={renamingAccount !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingAccount(null);
          }
        }}
      />
    </Sidebar>
  );
}

function AccountMenuItem({
  account,
  onRename,
}: {
  account: AccountSummary;
  onRename: (account: AccountSummary) => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild>
        <Link to={accountHref(account.id)}>
          <span className="truncate">{account.label}</span>
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            {formatCents(account.balanceCents)}
          </span>
        </Link>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover>
            <MoreHorizontal />
            <span className="sr-only">Account actions</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem onSelect={() => onRename(account)}>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

// Loading state: skeleton rows shaped like the real ones (label + balance placeholders), not a
// spinner. This app is client-fetched by design, so this is the primary first-paint state, not an
// edge case.
function AccountsSkeleton() {
  return (
    <SidebarMenu>
      {Array.from({ length: 5 }).map((_, index) => (
        <SidebarMenuItem key={index}>
          <div className="flex items-center gap-2 p-2">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-14 shrink-0" />
          </div>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
