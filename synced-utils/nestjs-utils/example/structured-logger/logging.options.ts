import { DEFAULT_SENSITIVE_HEADERS, type StructuredLoggerOptions } from '@rhyek/nestjs-utils';

// The one place this app configures logging. Exercises every option so the example doubles as a
// smoke test of the public surface.
export const loggingOptions: StructuredLoggerOptions = {
  strip: {
    headers: [DEFAULT_SENSITIVE_HEADERS, 'x-house-key'],
    json: ['creds.password', '*.ssn'],
  },
  mixins: [() => ['build', { sha: process.env.GIT_SHA ?? 'dev' }]],
  base: { service: 'example' },
};
