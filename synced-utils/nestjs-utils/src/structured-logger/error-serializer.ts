import pino from 'pino';
import { redactHeaders } from './strip';

/**
 * Why a custom serializer instead of plain `pino.stdSerializers.err`:
 *
 * `pino-std-serializers` uses `err.toJSON()` when the error defines one — and `AxiosError`
 * does. But `AxiosError.toJSON()` deliberately OMITS `response`, which is the single most
 * useful thing when an HTTP call fails (the status and the body the server sent back), while
 * still including the whole `config` — `Authorization` header included. So the default gives
 * you the least useful half of an axios error plus a credential leak.
 *
 * There is no established pino/axios serializer package; a custom serializer is the
 * documented approach. This one keeps the response, and redacts sensitive headers on both
 * sides.
 */

type AxiosLikeError = Error & {
  isAxiosError: true;
  code?: string;
  status?: number;
  config?: {
    method?: string;
    url?: string;
    baseURL?: string;
    params?: unknown;
    data?: unknown;
    headers?: unknown;
    timeout?: number;
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: unknown;
    data?: unknown;
  };
};

/**
 * Duck-typed on purpose — this is byte-for-byte what axios's own `axios.isAxiosError` does
 * (`isObject(payload) && payload.isAxiosError === true`; the flag is a plain own property set
 * in the `AxiosError` constructor). Checking the flag instead of importing `isAxiosError` from
 * axios keeps axios OUT of this service's dependencies: a service that never installs axios
 * still gets a working logger, and one that does gets the rich serialization for free.
 */
function isAxiosError(value: unknown): value is AxiosLikeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isAxiosError?: unknown }).isAxiosError === true
  );
}

/**
 * Serializer for the `error` / `err` log keys. Falls through to pino's standard error
 * serializer for everything that isn't an axios error.
 */
export function errorSerializer(error: unknown): unknown {
  if (!isAxiosError(error)) {
    return pino.stdSerializers.err(error as Error);
  }

  const { config, response } = error;

  return {
    type: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    isAxiosError: true,
    request: config
      ? {
          method: config.method,
          url: config.url,
          baseURL: config.baseURL,
          params: config.params,
          data: config.data,
          headers: redactHeaders(config.headers),
          timeout: config.timeout,
        }
      : undefined,
    // The half `AxiosError.toJSON()` throws away.
    response: response
      ? {
          status: response.status,
          statusText: response.statusText,
          headers: redactHeaders(response.headers),
          data: response.data,
        }
      : undefined,
  };
}
