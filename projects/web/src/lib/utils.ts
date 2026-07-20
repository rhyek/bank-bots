import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// The shadcn `cn` helper — join conditional class lists (clsx) and de-dupe conflicting Tailwind
// utilities (tailwind-merge). shadcn components import it as `~/lib/utils` (see components.json).
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
