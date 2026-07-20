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
      {/* Fixed width so the arrows don't shuffle sideways as the month name changes length. Sized
          to the widest label — "September 2026" measures 143px at this font — so w-40 (160px) clears
          it with a small margin and no dead space. */}
      <div className="w-40 text-center text-lg font-semibold">{formatMonth(month)}</div>
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
