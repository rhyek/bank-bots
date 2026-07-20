import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { currentMonth, formatMonth, shiftMonth } from '~/lib/filters';

/** `‹ July 2026 ›` plus a Today button, mirroring YNAB's month stepper. */
export function MonthNav({
  month,
  onChange,
}: {
  month: string;
  onChange: (month: string) => void;
}) {
  const today = currentMonth();

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="Previous month"
        onClick={() => onChange(shiftMonth(month, -1))}
      >
        <ChevronLeft className="size-4" />
      </Button>
      {/* Fixed width so the arrows don't shuffle sideways between "May 2026" and "September 2026". */}
      <div className="w-44 text-center text-lg font-semibold">{formatMonth(month)}</div>
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        aria-label="Next month"
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        <ChevronRight className="size-4" />
      </Button>
      <Button variant="ghost" size="sm" disabled={month === today} onClick={() => onChange(today)}>
        Today
      </Button>
    </div>
  );
}
