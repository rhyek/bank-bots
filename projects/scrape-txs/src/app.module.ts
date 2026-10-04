import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { StructuredLoggerModule } from '@rhyek/nestjs-utils';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { loggingOptions } from '~/logger/logging.options';
import { ScrapeModule } from '~/scrape/scrape.module';
import { StatusModule } from '~/status/status.module';

// nestjs-zod, globally: the pipe validates every param/body whose type is a ZodDto before a
// controller method runs, and the interceptor checks what a route returns against the DTO it
// declares with `@ZodSerializerDto`.
@Module({
  imports: [
    StructuredLoggerModule.forRoot(loggingOptions),
    ScheduleModule.forRoot(),
    StatusModule,
    ScrapeModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
