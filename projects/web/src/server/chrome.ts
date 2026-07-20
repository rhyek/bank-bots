import { createServerFn } from '@tanstack/react-start';
import { getCookie } from '@tanstack/react-start/server';

/**
 * The cookie-backed chrome state, read on the server so the first paint already has the right
 * theme and sidebar width. The vendored providers seed their `useState` from `getCookie(...)` in a
 * lazy initializer, which returns undefined during SSR and falls back to the default — without
 * this, a dark theme or a collapsed sidebar visibly flashes on every load and React warns about
 * the hydration mismatch.
 */
export const getChromeCookies = createServerFn().handler(() => ({
  theme: (getCookie('vite-ui-theme') ?? 'system') as 'light' | 'dark' | 'system',
  sidebarOpen: getCookie('sidebar_state') !== 'false',
}));
