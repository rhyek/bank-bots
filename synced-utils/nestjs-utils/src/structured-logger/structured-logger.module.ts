import { type DynamicModule, Global, Module } from '@nestjs/common';
import { type StructuredLoggerOptions, configureRootLogger } from './create-pino-logger';
import { StructuredLoggerService } from './structured-logger.service';

/**
 * `@Global()` so `StructuredLoggerService` is injectable everywhere after one import in
 * `AppModule` — a logger is genuinely cross-cutting, and re-importing a logger module into every
 * feature module is noise.
 */
@Global()
@Module({
  providers: [StructuredLoggerService],
  exports: [StructuredLoggerService],
})
export class StructuredLoggerModule {
  /**
   * Optional. `imports: [StructuredLoggerModule]` alone works and reads `LOG_LEVEL` from env.
   * Use `forRoot` to add app-specific pino serializers or base fields:
   *
   * ```ts
   * StructuredLoggerModule.forRoot({
   *   serializers: { user: (u: User) => ({ id: u.id, plan: u.plan }) },
   * })
   * ```
   *
   * Static because it must run before the first child logger is created — Nest evaluates the
   * `imports` array while loading `AppModule`, ahead of instantiating any provider.
   */
  static forRoot(options: StructuredLoggerOptions = {}): DynamicModule {
    configureRootLogger(options);
    return {
      module: StructuredLoggerModule,
      global: true,
      providers: [StructuredLoggerService],
      exports: [StructuredLoggerService],
    };
  }
}
