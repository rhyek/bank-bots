# structured-logger

Structured JSON logging for NestJS on [pino](https://getpino.io): automatic per-request context,
pluggable mixins, an axios-aware error serializer, and credential redaction across headers, query
string and request body.

Part of `@rhyek/nestjs-utils`; everything here is exported from the package root. See the
[package README](../../README.md) for installing it and what the consuming app must provide.

## Why

Wiring pino into Nest by hand means re-deriving the same four things every time: getting request
context onto every line without threading a logger through call signatures, getting Nest's _own_
logs into the same format, keeping credentials out of the output, and making axios failures
readable. This packages those decisions.

It is **not** a wrapper around `nestjs-pino`. That library binds a child logger per HTTP request via
`pino-http`, which is why `assign()` throws outside a request scope; this one keeps request data in
its own AsyncLocalStorage, so the logger works identically in a cron job, a queue consumer, or a
lifecycle hook.

## Setup

Two lines in `main.ts`, one in `app.module.ts`.

```ts
// main.ts
import { setupLogging } from '@rhyek/nestjs-utils';

const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
const logger = setupLogging(app);
```

`setupLogging` installs the Nest log adapter (so framework logs are structured too), the
request-context middleware, and the request-body interceptor. `bufferLogs: true` is passed
separately because it must be a `NestFactory.create` option.

```ts
// app.module.ts
import { StructuredLoggerModule } from '@rhyek/nestjs-utils';
import { loggingOptions } from './logging.options';

@Module({ imports: [StructuredLoggerModule.forRoot(loggingOptions), StatusModule] })
export class AppModule {}
```

The module is `@Global()`, so that one import makes `StructuredLoggerService` injectable
everywhere.

> `forRoot` is where behaviour is configured, and it cannot move into `setupLogging`: the root
> logger must exist before Nest instantiates the providers that inject a child logger, which
> happens during `NestFactory.create`.

## Logging

```ts
constructor(private readonly logger: StructuredLoggerService) {}

this.logger.info('order placed');
this.logger.info({ orderId }, 'order placed');
this.logger.error({ error, orderId }, 'charge failed');
```

`Scope.TRANSIENT` + `INQUIRER` means each injection site gets a child logger already tagged with
the injecting class, so every line carries `"context":"CheckoutService"` with no `setContext` call.

- **Two shapes only:** `(message)` or `(attributes, message)`. No printf interpolation — in a
  structured log an interpolated message is a string you can't query on, so the value belongs in
  the object where it becomes a field.
- **`error()` and `fatal()` require `error: Error`.** Such a line without the Error has no stack
  and nothing to act on. If there's no Error to attach, it's a `warn`.
- **`createError`** logs and returns a throwable in one step, so a failure can't be raised without
  being logged: `throw this.logger.createError({ orderId }, 'db constraint violated', { statusCode: 400, friendlyMessage: 'Could not place order' })`.

Known attributes autocomplete and are type-checked; anything else is still accepted. Widen the
known set by declaration merging:

```ts
declare module '@rhyek/nestjs-utils' {
  interface LogAttributes {
    orderId?: string;
  }
}
```

## What lands on every line

|                     |                                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Request context** | `req.method`, `req.url` and headers, credentials redacted. Enrich mid-request with `setRequestContext({ ... })` — e.g. the caller id once auth resolves — and widen its type via `RequestContextExtras`. Read from anywhere with `getRequestContext()` / `getRequestHeader(name)`. |
| **Request body**    | The parsed JSON body, via `RequestBodyInterceptor`. Runs after guards, so a guard-rejected request logs context but no body.                                                                                                                                                       |
| **Mixins**          | Whatever your own functions return.                                                                                                                                                                                                                                                |
| **Trace ids**       | Not from this library — see below.                                                                                                                                                                                                                                                 |

## Mixins

Each mixin runs on every emit and returns `[key, value]`, or `undefined` to contribute nothing.
This is the extension point for ambient state the request context doesn't cover — a queue
consumer's per-message scope, a job runner, a tenant resolver:

```ts
export const tenantStorage = new AsyncLocalStorage<{ tenantId: string }>();

const tenantMixin: LogMixin = () => {
  const store = tenantStorage.getStore();
  return store ? ['tenant', store] : undefined;
};

// logging.options.ts
mixins: [tenantMixin],
```

Each mixin owns exactly one top-level key, so mixins can't silently clobber each other. One that
throws is skipped and reported as `mixinError` on that line — a broken mixin never stops the app
logging. Static values belong in `base`, not a mixin.

## Keeping things out of the logs

One `strip` option, one rule per place a credential arrives:

```ts
StructuredLoggerModule.forRoot({
  strip: {
    headers: [DEFAULT_SENSITIVE_HEADERS, 'x-house-key', /^x-acme-/],
    url: [DEFAULT_SENSITIVE_URL_PARAMS, 'inviteCode'],
    json: ['creds.password', 'pin', '*.ssn', 'items[*].card'],
  },
});
```

- **`headers`** is a _name_ rule, applied to incoming request headers **and** outgoing axios
  headers from one place, so the two can't drift. Strings are exact names, RegExps match anywhere,
  always case-insensitive. The array **replaces** the default — include `DEFAULT_SENSITIVE_HEADERS`
  to extend it. The default already catches `x-shopify-access-token`, `x-hub-signature-256`,
  `x-csrf-token` and similar, while leaving `x-request-id` and `x-forwarded-for` alone.
- **`url`** is the same name rule over query parameters, rewriting the logged `req.url`. Its
  default is deliberately narrower — a query key is more likely to be an innocent word, so
  `?key=sortOrder&code=US` is untouched.
- **`json`** is a _path_ rule over the captured request body, written as the path appears in the
  payload (`creds.password`, not `req.body.creds.password`). Full pino `redact` syntax.

Only the value is replaced; the key stays, because "sent and wrong" and "never sent" are different
bugs. Redaction happens at emit, so **handlers still receive the real body** — the interceptor holds
a reference to `req.body` and scrubbing it in place would corrupt the data the app reads.

A credential in a URL is also in the proxy access log, browser history and `Referer`. `strip.url`
cleans _these_ logs; prefer a header for anything secret.

## Errors

The `error` serializer keeps an axios failure's `response` — status and body, which
`AxiosError.toJSON()` discards — with auth headers and cookies redacted on both sides. It
duck-types `isAxiosError` rather than importing axios, so it costs no dependency and works whether
or not axios is installed. Everything else falls through to `pino.stdSerializers.err`.

## Trace correlation

Deliberately absent. `@opentelemetry/instrumentation-pino` (bundled in
`@opentelemetry/auto-instrumentations-node`) injects `trace_id`, `span_id` and `trace_flags` into
every record itself, and ships records to the OTel Logs SDK. Anything written here would duplicate
it. It only works if the OTel bootstrap loads **before** pino, via `--import`.

## Output

Always JSON on stdout — no pino-pretty, no transport, no worker thread, in any environment. Logs
are byte-identical between a laptop and production; pipe through `pnpm dlx pino-pretty` when you
want them readable. Level is `LOG_LEVEL` (default `info`) and nothing else.

A line carries `level`, `msg`, `context` and what you put on it. pino's own **`time`, `pid` and
`hostname` are left out by default**: whatever reads the lines stamps them itself (a dev runner,
the container runtime's log driver, the OTel Logs SDK), and `pid` / `hostname` say nothing about
what happened. Bring them back when something downstream needs them:

```ts
StructuredLoggerModule.forRoot({
  timestamp: true, // pino's epoch-ms `time`; or pino.stdTimeFunctions.isoTime
  base: { pid: process.pid, hostname: hostname(), service: 'checkout' }, // static fields
});
```
