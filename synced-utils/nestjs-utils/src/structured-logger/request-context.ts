import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * App-specific request-scoped fields. Empty here on purpose — extend it by declaration merging
 * from wherever the shape lives, so this file never imports feature code:
 *
 * ```ts
 * // src/auth/api-key.guard.ts
 * declare module '@rhyek/nestjs-utils' {
 *   interface RequestContextExtras {
 *     clientId?: string;
 *   }
 * }
 * ```
 *
 * Then `setRequestContext({ clientId })` is type-checked, and `clientId` shows up under `req` on
 * every subsequent log line of that request.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RequestContextExtras {}

export type RequestContextStore = RequestContextExtras & {
  method?: string;
  url?: string;
  headers?: IncomingHttpHeaders;
  body?: unknown;
};

export const requestContextAsyncLocalStorage = new AsyncLocalStorage<RequestContextStore>();

export function getRequestContext(): RequestContextStore | undefined {
  return requestContextAsyncLocalStorage.getStore();
}

/**
 * Merge fields into the current request's context. Every log line emitted after this call carries
 * them under `req` — that's the point: enrich once at the edge (after auth resolves a caller,
 * say) instead of threading the value into every log call.
 *
 * No-ops outside a request rather than throwing, so shared code can call it from both an HTTP
 * path and a background job.
 */
export function setRequestContext(fields: Partial<RequestContextStore>): void {
  const store = requestContextAsyncLocalStorage.getStore();
  if (store) {
    Object.assign(store, fields);
  }
}

/**
 * Read one header (lowercase name, as Node stores them) from the current request's ALS scope.
 * Lets a service-layer path with no access to the request object reach a header it needs.
 * Returns undefined when there's no active request, the header is absent, or it arrived repeated
 * (as a string[]).
 */
export function getRequestHeader(name: string): string | undefined {
  const value = requestContextAsyncLocalStorage.getStore()?.headers?.[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}
