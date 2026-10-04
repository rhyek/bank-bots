// Public surface of structured-logger. Anything not re-exported here is an implementation detail.

export {
  createPinoLogger,
  configureRootLogger,
  getRootLogger,
  type LogMixin,
  type StripOptions,
  type StructuredLoggerOptions,
} from './create-pino-logger';

export { errorSerializer } from './error-serializer';

export {
  getRequestContext,
  getRequestHeader,
  requestContextAsyncLocalStorage,
  setRequestContext,
  type RequestContextExtras,
  type RequestContextStore,
} from './request-context';

export {
  LoggingContextMiddleware,
  NestStructuredLoggerService,
  RequestBodyInterceptor,
  setupLogging,
} from './setup-logging';

export {
  DEFAULT_SENSITIVE_HEADERS,
  DEFAULT_SENSITIVE_URL_PARAMS,
  REDACTED,
  isSensitiveHeader,
  isSensitiveUrlParam,
  redactHeaders,
  redactUrl,
  setSensitiveHeaders,
  setSensitiveUrlParams,
} from './strip';

export { StructuredLoggerModule } from './structured-logger.module';

export {
  StructuredLoggerService,
  type ErrorLogAttributes,
  type ErrorLogObject,
  type LogAttributes,
  type LogObject,
} from './structured-logger.service';
