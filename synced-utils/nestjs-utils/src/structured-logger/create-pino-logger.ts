import pino, { type Logger, type LoggerOptions } from 'pino';
import { errorSerializer } from './error-serializer';
import { requestContextAsyncLocalStorage } from './request-context';
import { REDACTED, setSensitiveHeaders, setSensitiveUrlParams } from './strip';

/**
 * Contributes one extra attribute to every log line. Called on each emit, so it can read whatever
 * ambient state it likes — typically an AsyncLocalStorage of your own — and return the key/value
 * to attach. Return `undefined` to contribute nothing for this line.
 *
 * A tuple rather than an object so each mixin owns exactly one top-level key: no silent clobbering
 * between mixins, and it stays obvious which mixin put a given field on the line.
 */
export type LogMixin = () => readonly [key: string, value: unknown] | undefined;

export type StructuredLoggerOptions = {
  /** Defaults to `LOG_LEVEL` env var, else `info`. */
  level?: pino.LevelWithSilentOrString;
  /**
   * Extra attributes on every line, each from a function evaluated at emit time. This is the
   * extension point for anything ambient the built-ins don't cover — see "Mixins" in the README
   * for a worked example backed by AsyncLocalStorage.
   *
   * Applied after the built-in `req`, so a mixin returning the key `'req'` would replace it. A
   * mixin that throws is skipped and reported as `mixinError` on that line, rather than taking
   * down the call that tried to log.
   */
  mixins?: readonly LogMixin[];
  /**
   * Extra pino serializers, merged over the built-ins. Register app-specific ones here rather
   * than editing this file — e.g. `{ user: (u) => ({ id: u.id }) }`. Passing `error`/`err`
   * replaces the built-in axios-aware serializer.
   */
  serializers?: LoggerOptions['serializers'];
  /**
   * Static fields on every line. Empty by default: pino's own `pid` and `hostname` are left OUT —
   * they say nothing about what happened, and whatever runs the process (a dev runner, the
   * container platform) already knows which instance wrote a line. To have them back:
   *
   * ```ts
   * base: { pid: process.pid, hostname: hostname() }
   * ```
   */
  base?: LoggerOptions['base'];
  /**
   * pino's `time` field. Off by default: every consumer of these lines stamps them itself — the
   * dev runner, the container runtime's log driver, and the OTel Logs SDK (which falls back to
   * the emit time when the record carries none). Pass `true` for epoch milliseconds, or a pino
   * time function such as `pino.stdTimeFunctions.isoTime`, when something downstream parses `time`.
   */
  timestamp?: LoggerOptions['timestamp'];
  /** What never reaches the logs. See {@link StripOptions}. */
  strip?: StripOptions;
};

/**
 * Three rules, one per place a credential arrives: the headers, the query string, and the body.
 *
 * `headers` and `url` are NAME rules — you don't know what the thing will be called, so you match
 * a shape (`/token/`) — and both are on by default. `json` is a PATH rule over the captured
 * request body: you know exactly which field holds the secret, so you name it, and there is no
 * useful default because payload shapes are per-app.
 */
export type StripOptions = {
  /**
   * Header names whose values get redacted — in request context AND in serialized axios errors,
   * so the two can't drift. Strings are exact names, RegExps match anywhere in the name; always
   * case-insensitive. REPLACES the default, so include `DEFAULT_SENSITIVE_HEADERS` to extend it:
   *
   * ```ts
   * strip: { headers: [DEFAULT_SENSITIVE_HEADERS, 'x-house-key'] }
   * ```
   *
   * `[]` means redact no headers at all.
   */
  headers?: readonly (RegExp | string)[];
  /**
   * Query-parameter names whose values get redacted in the logged `req.url`, same matching rules
   * as `headers`. REPLACES `DEFAULT_SENSITIVE_URL_PARAMS`, so include it to extend:
   *
   * ```ts
   * strip: { url: [DEFAULT_SENSITIVE_URL_PARAMS, 'inviteCode'] }
   * ```
   *
   * The default is narrower than the header rule on purpose — a query key is much more likely to
   * be an innocent word. `[]` means redact nothing in the URL.
   */
  url?: readonly (RegExp | string)[];
  /**
   * Paths INSIDE the captured JSON request body, so `'creds.password'` strips the `password`
   * under a top-level `creds` object — you write the path as it appears in the payload, not as it
   * appears in the log line (these are prefixed with `req.body.` for you).
   *
   * pino `redact` syntax, so wildcards and brackets work: `'*.ssn'`, `'items[*].card'`,
   * `'meta["x-one-off"]'`.
   *
   * Only meaningful while `RequestBodyInterceptor` is installed by `setupLogging` — that's what
   * puts the body on the log line in the first place. Drop it and these are no-ops.
   */
  json?: readonly string[];
};

/**
 * One pino logger, always structured JSON on stdout — no pino-pretty, no transport, no worker
 * thread, in any environment. Reading raw JSON locally is a fine trade for logs that are
 * byte-identical between your laptop and production; pipe through `pnpm dlx pino-pretty` when
 * you want them readable.
 *
 * Trace correlation is deliberately NOT here. `@opentelemetry/instrumentation-pino` (bundled in
 * `@opentelemetry/auto-instrumentations-node`) patches pino and injects `trace_id`, `span_id`
 * and `trace_flags` into every record on its own, and ships records to the OTel Logs SDK. That
 * only works if the OTel bootstrap loads BEFORE pino, via `--import`.
 */
export function createPinoLogger(options: StructuredLoggerOptions = {}): Logger {
  const mixins = options.mixins ?? [];

  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    // Emit `"level":"info"` rather than pino's numeric level — most backends (SigNoz included)
    // map the text form to severity without a pipeline rule.
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    // Log a thrown Error under `error` instead of pino's default `err`.
    errorKey: 'error',
    // `null`, not `undefined`: undefined means pino's default `{ pid, hostname }`.
    base: options.base ?? null,
    timestamp: options.timestamp ?? false,
    // Body paths are anchored to the body root for the caller, then redacted by pino at emit
    // time. Deliberately NOT redacted in the interceptor: it stores a reference to the real
    // `req.body`, so scrubbing there would mutate the object the controllers themselves read.
    ...(options.strip?.json?.length
      ? {
          redact: {
            paths: options.strip.json.map((path) => `req.body.${path}`),
            censor: REDACTED,
          },
        }
      : {}),
    serializers: {
      error: errorSerializer,
      err: errorSerializer,
      ...options.serializers,
    },
    mixin() {
      const req = requestContextAsyncLocalStorage.getStore();
      const attrs: Record<string, unknown> = req ? { req } : {};

      for (const mixin of mixins) {
        try {
          const entry = mixin();
          if (entry) {
            attrs[entry[0]] = entry[1];
          }
        } catch (error) {
          // A broken mixin must never make the app unable to log. Surface it on the line rather
          // than swallowing it — noisy on purpose, because it means a mixin needs fixing.
          attrs.mixinError = error instanceof Error ? error.message : String(error);
        }
      }

      return attrs;
    },
    // Without this, pino mutates the mixin object, so every later log inherits the previous
    // call's merge-object fields.
    mixinMergeStrategy(mergeObject, mixinObject) {
      return Object.assign({}, mixinObject, mergeObject);
    },
  });
}

let rootLogger: Logger | undefined;

/**
 * Build the process-wide root logger with explicit options. Called by
 * `StructuredLoggerModule.forRoot()`. Must run before any child logger is created — importing
 * `AppModule` evaluates `forRoot(...)` before Nest instantiates anything, so that holds.
 */
export function configureRootLogger(options?: StructuredLoggerOptions): Logger {
  if (options?.strip?.headers) {
    setSensitiveHeaders(options.strip.headers);
  }
  if (options?.strip?.url) {
    setSensitiveUrlParams(options.strip.url);
  }
  rootLogger = createPinoLogger(options);
  return rootLogger;
}

/** The root logger, lazily created with defaults if `forRoot()` never configured one. */
export function getRootLogger(): Logger {
  return (rootLogger ??= createPinoLogger());
}
