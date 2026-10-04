import { Module } from '@nestjs/common';
import { StructuredLoggerModule } from '@rhyek/nestjs-utils';
import { loggingOptions } from './logging.options';
import { StatusModule } from './status/status.module';

@Module({ imports: [StructuredLoggerModule.forRoot(loggingOptions), StatusModule] })
export class AppModule {}
