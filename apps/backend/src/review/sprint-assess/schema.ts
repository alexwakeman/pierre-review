import type { z as Zod } from 'zod';
import { loadZod } from '../../ai/runtime.js';

// The structured-output contract for the sprint assessment's in-process `submit_assessment` tool.
// BUILT from a zod namespace handed in (the AI runtime's own install — review/schema.ts explains why
// a second zod instance silently breaks the SDK's tool schemas).
//
// The shape is deliberately LENIENT (optional where a model may reasonably leave something out):
// the SERVER validator (validate.ts) is the contract — it enforces caps, enums, criterion numbers
// and verifies every cited path against the checkout, dropping what does not hold.

type ZodNs = typeof Zod;

export function buildSubmitAssessmentShape(z: ZodNs) {
  const text = z.string();
  const list = z.array(z.string());
  return {
    criteria: z
      .array(
        z.object({
          n: z.number().int().describe('The criterion number from the ticket (1-based).'),
          testableAgainstCode: z
            .boolean()
            .describe('true when someone could check this criterion by reading or running the code.'),
          landsIn: z
            .array(
              z.object({
                repo: z.string().describe('owner/name of one of the listed repos.'),
                path: z.string().describe('Repo-relative path of a file or directory you opened, e.g. src/api/users.ts'),
                symbol: z.string().nullable().optional().describe('A function, class or route name, if one fits.'),
              }),
            )
            .describe('Where the change would land. Only paths you actually saw.'),
          existing: z
            .enum(['none', 'partial', 'full', 'unclear'])
            .describe('Does the code already do what the criterion asks?'),
          note: text.describe('One or two sentences on why.'),
        }),
      )
      .describe('One entry per numbered criterion of the ticket.'),
    gaps: z.object({
      unnamedDependencies: list.describe('Other work, teams or services this story needs that the ticket does not name.'),
      unstatedBehaviourChanges: list.describe('Behaviour the change would alter that the ticket does not mention.'),
      dataOrMigrationImpact: list.describe('Data, schema or migration consequences.'),
      edgeCases: list.describe('Cases the criteria do not cover.'),
    }),
    suggestion: z.object({
      rewrittenCriteria: z
        .array(z.object({ n: z.number().int(), text }))
        .describe('A clearer, checkable wording for criterion n. Only where it helps.'),
      addedCriteria: list.describe('Criteria the ticket should add.'),
      split: z
        .array(z.object({ title: text, criteria: list }))
        .nullable()
        .optional()
        .describe('A proposed split into smaller stories, or null when it is one piece of work.'),
      questionsForOwner: list.describe('Questions the code cannot answer, for the ticket owner.'),
      summary: text.describe('Two or three plain sentences on how ready this ticket is to build.'),
    }),
  };
}

export type SubmitAssessmentShape = ReturnType<typeof buildSubmitAssessmentShape>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitAssessmentShape(): Promise<SubmitAssessmentShape> {
  return buildSubmitAssessmentShape(await loadZod());
}
