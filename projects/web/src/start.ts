// TanStack Start instance config. Two global middlewares live here:
//   1. requestMiddleware  — the same-origin CSRF check for server functions. Keep it: this
//      protection is opt-in in current TanStack Start (because this app defines a `createStart`
//      instance, Start does NOT auto-inject the default CSRF middleware), so without it server fns
//      aren't origin-checked at all and Start logs "not protected by the CSRF middleware".
//   2. functionMiddleware — the ONE place every server-fn failure is surfaced (see below).
import { createStart, createCsrfMiddleware, createMiddleware } from '@tanstack/react-start';
import { toast } from 'sonner';

const csrf = createCsrfMiddleware({
  // Scope to server fns so router (SSR/document) requests are untouched.
  filter: (ctx) => ctx.handlerType === 'serverFn',
  // The default check is same-origin (Sec-Fetch-Site → Origin → Referer) — correct for most apps,
  // so leave `origin` unset. ONLY set it behind a proxy that terminates TLS and strips Sec-Fetch-*
  // (e.g. a Cloudflare Tunnel): there the check falls back to comparing the browser's https `Origin`
  // against the internal http request URL → 403 on every server-fn POST (reads run in the SSR loader,
  // so only WRITES fail). Exact-match your public origin in that case:
  // origin: 'https://REPLACE-WITH-YOUR-PUBLIC-ORIGIN',
});

// Global server-fn error surface. The `.client()` phase wraps every server-fn call in the browser;
// on a rejection it toasts MUTATION (POST) failures — the state-changing calls where a silent
// failure is dangerous — then RE-THROWS so existing call-site handling + loaders still run (additive;
// it never hides an error). Reads (GET, in loaders) surface through the root route's errorComponent
// instead. Server-thrown Error messages serialize to the client, so `err.message` is the real cause.
const surfaceErrors = createMiddleware({ type: 'function' }).client(async ({ next, method }) => {
  try {
    return await next();
  } catch (err) {
    if (method === 'POST') {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf],
  functionMiddleware: [surfaceErrors],
}));
