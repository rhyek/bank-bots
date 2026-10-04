import { z } from 'zod';

/**
 * What the agent must return.
 *
 * Deliberately shallow. The SDK re-prompts on a schema mismatch and gives up after a retry limit,
 * and deeply nested schemas with many required fields are the documented way to hit that limit —
 * so anything derivable elsewhere is kept out. In particular the created/updated ids are absent:
 * the write tools record those as they fire, which is both simpler here and more trustworthy than
 * asking the model to report its own side effects.
 */
export const Answer = z.object({
  matched: z
    .boolean()
    .describe(
      'true when you know who the payee is and have chosen a category for it; false for no match',
    ),
  payeeId: z
    .string()
    .nullable()
    .describe('An existing or newly created payee id; null if no match'),
  categoryId: z.string().nullable().describe('A category id from the list; null if no match'),
  confidence: z.enum(['high', 'medium', 'low']),
  summary: z
    .string()
    .describe('How you reached this answer, including what you ruled out. Kept as an audit trail.'),
});

export type Answer = z.infer<typeof Answer>;
