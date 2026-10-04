import type { StructuredLoggerOptions } from '@rhyek/nestjs-utils';
import { runMixin } from '~/scrape/run-context';

// No `strip` rules beyond the defaults: the service has no inbound authentication and no request
// body carries a secret. Bank credentials never reach a log line — they are passed as arguments,
// never put in log attributes.
export const loggingOptions: StructuredLoggerOptions = {
  mixins: [runMixin],
};
