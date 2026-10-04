import { HttpException, type HttpStatus, Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import type pino from 'pino';
import type { Logger } from 'pino';
import { getRootLogger } from './create-pino-logger';

/**
 * Well-known log attributes — the ones that get autocompleted and type-checked. Extend it for
 * this app by declaration merging, so common attributes are spelled consistently instead of
 * `orderId` here and `order_id` three files away:
 *
 * ```ts
 * // src/orders/orders.service.ts
 * declare module '@rhyek/nestjs-utils' {
 *   interface LogAttributes {
 *     orderId?: string;
 *   }
 * }
 * ```
 *
 * Anything NOT listed here is still allowed (see {@link LogObject}) — this is about giving the
 * attributes you use everywhere one canonical name and type, not about locking the set down.
 */
export interface LogAttributes {
  /**
   * The error being reported. Runs through the axios-aware serializer, so an axios failure keeps
   * its response status and body. Required by {@link StructuredLoggerService.error}.
   */
  error?: Error;
}

/**
 * The object accepted by every log method: known attributes typed and autocompleted, any other key
 * still allowed. The `Record<string, unknown>` half defeats the excess-property check for one-off
 * fields, while the intersection keeps `LogAttributes` members type-checked — `{ error: 'boom' }`
 * still fails.
 *
 * Every level declares this overload FIRST, because it is what drives editor autocomplete, and a
 * `<T extends object>` overload SECOND. The second exists because an object literal gets an
 * implicit index signature but an **interface never does**, so a pre-built typed value would
 * otherwise be rejected:
 *
 * ```ts
 * const result: SyncResult = ...;          // interface
 * logger.info(result, 'batch applied');    // needs the generic overload
 * ```
 *
 * The generic one still intersects `LogAttributes`, so it cannot be used to smuggle a wrongly
 * typed known attribute past the check.
 */
export type LogObject = LogAttributes & Record<string, unknown>;

/** `LogAttributes` with `error` mandatory — what {@link StructuredLoggerService.error} demands. */
export type ErrorLogAttributes = LogAttributes & { error: Error };

/** Same, plus the index signature, for the autocompleting `error()` overload. */
export type ErrorLogObject = LogObject & { error: Error };

/**
 * Inject this anywhere. `Scope.TRANSIENT` + `INQUIRER` is what makes `context` automatic: Nest
 * hands each injection site its own instance and tells us which class asked for it, so every
 * line carries `"context":"CheckoutService"` with no `setContext` call and no per-class logger
 * boilerplate.
 *
 * The cost of TRANSIENT is a new instance per injection site (not per request) — negligible, and
 * request data comes from AsyncLocalStorage rather than request scope, so this never forces
 * request-scoped instantiation of the classes that inject it.
 *
 * Every level takes either `(message)` or `(attributes, message)` — deliberately narrower than
 * pino's own signature, which also accepts printf-style interpolation (`info('a %s', b)`). In a
 * structured log an interpolated message is a string you then can't query on; put the value in
 * the object instead, where it becomes a field.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class StructuredLoggerService {
  /** The underlying pino logger — for the rare call that needs an API this doesn't wrap. */
  public pino: Logger;

  constructor(
    @Inject(INQUIRER)
    parentClass?: object,
  ) {
    this.pino = getRootLogger().child({
      context:
        parentClass?.constructor?.name === 'Function'
          ? (parentClass as { name?: string }).name
          : parentClass?.constructor?.name,
    });
  }

  setContext(name: string) {
    // In Nest preview mode (used for schema generation) transient providers skip constructor
    // execution, leaving `pino` undefined.
    this.pino?.setBindings({ context: name });
  }

  setLevel(level: pino.LevelWithSilentOrString) {
    this.pino.level = level;
  }

  get level() {
    return this.pino.level;
  }

  trace(message: string): void;
  trace(attributes: LogObject, message: string): void;
  trace<T extends object>(attributes: T & LogAttributes, message: string): void;
  trace(a: LogAttributes | string, b?: string): void {
    this.write('trace', a, b);
  }

  debug(message: string): void;
  debug(attributes: LogObject, message: string): void;
  debug<T extends object>(attributes: T & LogAttributes, message: string): void;
  debug(a: LogAttributes | string, b?: string): void {
    this.write('debug', a, b);
  }

  info(message: string): void;
  info(attributes: LogObject, message: string): void;
  info<T extends object>(attributes: T & LogAttributes, message: string): void;
  info(a: LogAttributes | string, b?: string): void {
    this.write('info', a, b);
  }

  warn(message: string): void;
  warn(attributes: LogObject, message: string): void;
  warn<T extends object>(attributes: T & LogAttributes, message: string): void;
  warn(a: LogAttributes | string, b?: string): void {
    this.write('warn', a, b);
  }

  /**
   * `error` is REQUIRED — there is no message-only overload on `error` or `fatal`. An error line
   * without the Error is the one you regret later: no stack, no cause, nothing to act on. If you
   * genuinely have no Error to attach, the event is a `warn`.
   */
  error(attributes: ErrorLogObject, message: string): void;
  error<T extends object>(attributes: T & ErrorLogAttributes, message: string): void;
  error(attributes: LogAttributes, message: string): void {
    this.write('error', attributes, message);
  }

  /** Same required `error` as {@link StructuredLoggerService.error} — see the note there. */
  fatal(attributes: ErrorLogObject, message: string): void;
  fatal<T extends object>(attributes: T & ErrorLogAttributes, message: string): void;
  fatal(attributes: LogAttributes, message: string): void {
    this.write('fatal', attributes, message);
  }

  /**
   * Logs `message` (always — this is the internal log line) with `attributes` as structured
   * context, then returns an Error for you to throw. `options.friendlyMessage`, when given, is
   * what reaches the client; otherwise `message` is used. Keep `message` detailed for debugging
   * and `friendlyMessage` safe for users.
   *
   * `throw logger.createError(...)` in one line means a failure can't be raised without also being
   * logged with its context. Unlike `error()` it does not require an `error` — it is the thing
   * that creates one — though you can still pass the cause under `error` when re-wrapping.
   */
  createError<T extends object>(
    attributes: T & LogAttributes,
    message: string,
    options?: {
      statusCode?: HttpStatus;
      friendlyMessage?: string;
    },
  ): Error {
    this.write('error', { ...attributes, createErrorOptions: options }, message);
    const clientMessage = options?.friendlyMessage ?? message;
    if (options?.statusCode) {
      return new HttpException(clientMessage, options.statusCode);
    }
    return new Error(clientMessage);
  }

  private write(level: pino.Level, a: LogAttributes | string, b?: string): void {
    if (typeof a === 'string') {
      this.pino[level](a);
    } else {
      this.pino[level](a, b);
    }
  }
}
