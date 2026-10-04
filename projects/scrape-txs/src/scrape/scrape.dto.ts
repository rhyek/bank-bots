import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { bankKeySchema } from '~/bank-config/bank-keys';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM');

export const bankKeyParamsSchema = z.object({ bankKey: bankKeySchema });

// A run id is a `scrape_run.id`: anything that is not a uuid is rejected here, before Postgres.
export const runIdParamsSchema = z.object({ runId: z.uuid() });

// Strict, so a misspelled field is a 400 instead of a scrape with default parameters. The
// preprocess is for a POST with no body at all: Express 5 leaves `req.body` undefined then.
export const scrapeBodySchema = z.preprocess(
  (body) => body ?? {},
  z.strictObject({
    months: z.array(monthSchema).min(1).optional(),
    account: z.string().min(1).optional(),
    dryRun: z.boolean().default(false),
  }),
);

export const runParamsSchema = z.object({
  months: z.array(monthSchema),
  account: z.string().optional(),
  dryRun: z.boolean(),
});

// `upserted` and `deleted` count what the scrape found: rows to write, and stored rows the bank no
// longer lists. A dry run reports the same counts and writes neither.
export const runResultSchema = z.object({
  upserted: z.number().int(),
  deleted: z.number().int(),
  balancesUpdated: z.number().int(),
  dryRunPath: z.string().optional(),
});

export const runErrorSchema = z.object({
  message: z.string(),
  // Where the run stopped: reading the `config` row, Bitwarden, the bank's site, or the database.
  stage: z.enum(['config', 'credentials', 'scrape', 'persist']),
  tracePath: z.string().optional(),
});

export const runSchema = z.object({
  runId: z.uuid(),
  bankKey: bankKeySchema,
  trigger: z.enum(['schedule', 'manual']),
  status: z.enum(['running', 'succeeded', 'failed']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  params: runParamsSchema,
  result: runResultSchema.nullable(),
  error: runErrorSchema.nullable(),
});

export type RunParams = z.infer<typeof runParamsSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type RunError = z.infer<typeof runErrorSchema>;
export type RunStage = RunError['stage'];
export type RunTrigger = z.infer<typeof runSchema>['trigger'];
export type Run = z.infer<typeof runSchema>;

export class BankKeyParamsDto extends createZodDto(bankKeyParamsSchema) {}
export class ScrapeBodyDto extends createZodDto(scrapeBodySchema) {}
export class RunIdParamsDto extends createZodDto(runIdParamsSchema) {}
export class RunDto extends createZodDto(runSchema) {}
