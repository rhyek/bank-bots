import { Toaster as Sonner, type ToasterProps } from 'sonner';

// shadcn's `sonner` component, adapted. The stock generated wrapper reads the theme from
// `next-themes`, which this dark-only console doesn't use — hard-coding `theme="dark"` is the one
// sanctioned edit to a `ui/` file (a generated wrapper hard-coding an integration we don't have).
// `richColors` gives error/success toasts their semantic colors against the dark chrome.
const Toaster = (props: ToasterProps) => (
  <Sonner theme="dark" richColors position="bottom-right" {...props} />
);

export { Toaster };
