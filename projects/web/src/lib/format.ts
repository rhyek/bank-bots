// Every tracked account is USD (bank_account.currency is 'USD' on every row), so the currency is
// fixed here rather than threaded through every call site.
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Integer cents → "$1,234.56". Division by 100 happens here and nowhere else. */
export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/** "2026-07-11" → "Jul 11, 2026". Input is a plain date string, never a Date, to dodge timezones. */
export function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
