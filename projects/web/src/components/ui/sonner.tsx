import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useTheme } from '~/context/theme-provider';

// shadcn's `sonner` component, adapted. The stock generated wrapper reads the theme from
// `next-themes`, which this app doesn't use — swapping that for our own `useTheme` is the one
// sanctioned edit to a `ui/` file (a generated wrapper hard-coding an integration we don't have).
// `resolvedTheme` rather than `theme`, so a 'system' preference reaches sonner as a concrete
// 'light' | 'dark' instead of being passed through as an unrecognized value.
// `richColors` gives error/success toasts their semantic colors.
const Toaster = (props: ToasterProps) => {
  const { resolvedTheme } = useTheme();
  return <Sonner theme={resolvedTheme} richColors position="bottom-right" {...props} />;
};

export { Toaster };
