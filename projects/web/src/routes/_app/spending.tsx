import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Header } from '~/components/layout/header';
import { Main } from '~/components/layout/main';
import { ThemeSwitch } from '~/components/theme-switch';
import { ActivityDialog, type Drilldown } from '~/components/spending/activity-dialog';
import { CategoryTable } from '~/components/spending/category-table';
import { MonthNav } from '~/components/spending/month-nav';
import { SummaryHeader } from '~/components/spending/summary-header';
import { monthSummaryQueryOptions } from '~/lib/queries';
import { spendingSearchSchema } from '~/lib/filters';

export const Route = createFileRoute('/_app/spending')({
  component: Spending,
  validateSearch: spendingSearchSchema,
});

function Spending() {
  const { month } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [drilldown, setDrilldown] = useState<Drilldown | null>(null);

  const { data: summary } = useQuery(monthSummaryQueryOptions(month));

  return (
    <>
      <Header>
        <h1 className="text-lg font-semibold">Spending</h1>
        <div className="ms-auto">
          <ThemeSwitch />
        </div>
      </Header>
      {/* The category table owns the only scrollbar, same arrangement as the register pages. */}
      <Main fixed fluid className="h-[calc(100svh-4rem)]">
        <div className="flex flex-col gap-3 pb-3">
          <MonthNav
            month={month}
            // `replace` keeps month-stepping out of the back-button history: paging through six
            // months should not mean six presses of Back to leave the page.
            onChange={(next) => navigate({ search: { month: next }, replace: true })}
          />
          <SummaryHeader
            summary={summary}
            onDrill={(bucket, title) => setDrilldown({ bucket, title })}
          />
        </div>

        <CategoryTable
          summary={summary}
          onDrill={(bucket, title) => setDrilldown({ bucket, title })}
        />

        <ActivityDialog month={month} drilldown={drilldown} onClose={() => setDrilldown(null)} />
      </Main>
    </>
  );
}
