import type { z as Zod } from 'zod';
import { loadZod } from '../../ai/runtime.js';

// The structured-output contract for the CI review's in-process `submit_ci_review` tool. Built from
// a zod namespace handed in (the AI runtime's own install — review/schema.ts explains why a second
// zod instance silently breaks the SDK's tool schemas).
//
// Failures are named by their REF from the prompt ('F1', 'F2', …), never by a check name the model
// could invent; the server maps refs back and drops any it did not hand out (reconcile.ts).
// 'not_checked' is in NO enum here: only the server writes it.

type ZodNs = typeof Zod;

export function buildSubmitCiReviewShape(z: ZodNs) {
  return {
    summary: z
      .string()
      .describe('Markdown: one or two sentences on why CI is red, in plain words. No headings.'),
    failures: z
      .array(
        z.object({
          ref: z.string().describe("The failure's ref from the 'Failing checks' section, e.g. 'F1'."),
          cause: z.string().describe('The cause in a few words.'),
          explanation: z
            .string()
            .describe('One to three sentences that name the log lines and the code you checked.'),
          category: z.enum(['code', 'test', 'flaky_or_infra', 'config', 'unclear']),
          fixableInPr: z.boolean().describe('true when a change to this pull request would make the check pass.'),
          confidence: z
            .number()
            .int()
            .min(0)
            .max(100)
            .describe('How sure you are of the cause, 0-100. Above 50 only when the log lines you name show it.'),
          step: z
            .string()
            .nullable()
            .optional()
            .describe('The failing step, only when the section does not name it and the log shows it.'),
          path: z
            .string()
            .nullable()
            .optional()
            .describe('The one file in this repository to change, when there is one.'),
          line: z.number().int().nullable().optional(),
          suggestion: z
            .string()
            .nullable()
            .optional()
            .describe('The change that would make the check pass, in one or two sentences. Leave it out when you do not know.'),
          relatedFiles: z
            .array(z.object({ path: z.string(), line: z.number().int().nullable().optional() }))
            .optional()
            .describe('Other files in this repository the failure points at, with a line when known.'),
        }),
      )
      .describe("One entry per failure in the 'Failing checks' section, each ref once. Leave out a ref you cannot judge rather than guess."),
  };
}

export type SubmitCiReviewShape = ReturnType<typeof buildSubmitCiReviewShape>;
export type SubmitCiReviewPayload = Zod.infer<Zod.ZodObject<SubmitCiReviewShape>>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitCiReviewShape(): Promise<SubmitCiReviewShape> {
  return buildSubmitCiReviewShape(await loadZod());
}
