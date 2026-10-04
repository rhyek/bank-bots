import type { IncomingMessage } from 'node:http';
import {
  type CallHandler,
  ConsoleLogger,
  type ExecutionContext,
  type INestApplication,
  Injectable,
  type NestInterceptor,
  type NestMiddleware,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { requestContextAsyncLocalStorage } from './request-context';
import { redactHeaders, redactUrl } from './strip';
import { StructuredLoggerService } from './structured-logger.service';

/**
 * Everything that plugs the logger into Nest at bootstrap: the framework log adapter, the
 * request-context middleware, the body interceptor, and the one function `main.ts` calls.
 *
 * These three classes exist only to serve `setupLogging`, so they live beside it rather than in
 * files of their own — logging should be one folder you can read top to bottom, not a scattering.
 *
 * Behaviour knobs (level, `strip`, serializers) are NOT here — they're in `logging.options.ts`,
 * applied via `StructuredLoggerModule.forRoot()`. That split is forced, not stylistic: the root
 * logger must be configured before Nest instantiates the providers that inject a child logger,
 * which happens during `NestFactory.create` — before this function could ever run.
 */

type IncomingHttpHeadersLike = IncomingMessage['headers'];

// Nest logs one line per module and per route at boot, saying nothing a reader needs.
const SUPPRESSED_CONTEXTS = new Set(['InstanceLoader', 'RoutesResolver', 'RouterExplorer']);

/**
 * Routes NestJS's OWN logs (startup, unhandled exceptions, shutdown) through the structured
 * logger. Without it a service emits two formats — pretty console lines from the framework, JSON
 * from your code — and the framework half is invisible to the log backend.
 */
@Injectable()
export class NestStructuredLoggerService extends ConsoleLogger {
  // Constructed directly rather than injected: this is created before the DI container exists.
  private logger = new StructuredLoggerService();

  log(message: unknown, context?: string) {
    if (context && SUPPRESSED_CONTEXTS.has(context)) {
      return;
    }
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, stack?: string, context?: string) {
    // Nest hands us a message and a stack STRING, never an Error. Reconstitute one so this goes
    // through the same `error` serializer as application errors and the required-error contract
    // holds — otherwise framework errors would be the only unstructured ones in the log.
    const error = message instanceof Error ? message : new Error(String(message));
    if (stack) {
      error.stack = stack;
    }
    this.logger.error({ context, error }, String(message));
  }

  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }

  fatal(message: unknown, context?: string) {
    // Same reconstitution as `error` above — Nest never hands us an Error, and `fatal` requires one.
    const error = message instanceof Error ? message : new Error(String(message));
    this.logger.fatal({ context, error }, String(message));
  }
}

/**
 * Opens the per-request AsyncLocalStorage scopes that put request context on every downstream log
 * line automatically — no passing a logger or a correlation value around.
 *
 * Purpose-built for logging and nothing else: it reads the request, it does not modify it, and it
 * sets no response headers. (Propagating a request id across services is a separate concern —
 * add a dedicated middleware for it if you ever want one, and `setRequestContext({ requestId })`
 * to get it onto the logs.)
 */
@Injectable()
export class LoggingContextMiddleware implements NestMiddleware {
  use(req: IncomingMessage, _res: unknown, next: () => void) {
    // Redact once, here, so the context store itself never holds a credential — anything that
    // later reads it (a log line, an error report) is safe by construction.
    const headers = redactHeaders(req.headers) as IncomingHttpHeadersLike;

    // Prefer Express's `originalUrl` — the full URL before any router-level path rewriting from a
    // sub-app mount. Fall back to `url` for non-Express adapters. Redacted too: a credential in
    // the query string would otherwise be logged in full on every request carrying it.
    const url = redactUrl(
      (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url,
    );

    requestContextAsyncLocalStorage.run({ method: req.method, url, headers }, next);
  }
}

/**
 * Adds the parsed request body to the request context, so a failure logged deep in a service
 * shows what was actually sent without anyone logging the DTO by hand.
 *
 * An interceptor, not middleware: it has to run AFTER body parsing. It only reads a reference to
 * the already-parsed body — no second stream read — so `@Body()` and validation pipes are
 * unaffected, and nothing mutates the object handlers receive.
 *
 * Consequence of that placement: interceptors run after GUARDS, so a request rejected by a guard
 * logs with request context but no `req.body`. Usually what you want — just don't go looking for
 * a body on a 401 line.
 *
 * The whole body goes into the logs. To keep a field out, add its path to `strip.json` in
 * `logging.options.ts`.
 */
@Injectable()
export class RequestBodyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<{ body?: unknown }>();
      const store = requestContextAsyncLocalStorage.getStore();
      if (store && isCapturableBody(req?.body)) {
        store.body = req.body;
      }
    }
    return next.handle();
  }
}

function isCapturableBody(body: unknown): boolean {
  if (body === undefined || body === null || typeof body !== 'object') {
    return false;
  }
  if (Buffer.isBuffer(body)) {
    return false;
  }
  // The JSON body parser yields `{}` when there's no body — skip that empty case.
  return Object.keys(body as Record<string, unknown>).length > 0;
}

/**
 * All logging bootstrap wiring, so `main.ts` needs one line. Pair it with
 * `NestFactory.create(AppModule, { bufferLogs: true })` — that option has to be passed at create
 * time, so it's the one piece that can't live here.
 *
 * ```ts
 * const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
 * const logger = setupLogging(app);
 * ```
 */
export function setupLogging(app: INestApplication): NestStructuredLoggerService {
  const logger = new NestStructuredLoggerService();
  app.useLogger(logger);
  app.flushLogs();

  // `app.use` rather than a module's `configure()`/`forRoutes()`: this runs ahead of body
  // parsing, guards and interceptors, and covers requests that match no route at all — so an
  // unhandled 404 or a guard rejection still logs with request context attached.
  const middleware = new LoggingContextMiddleware();
  app.use(middleware.use.bind(middleware));

  // Remove this line to stop putting request bodies on log lines entirely.
  app.useGlobalInterceptors(new RequestBodyInterceptor());

  return logger;
}
