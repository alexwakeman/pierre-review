import type { z as Zod } from 'zod';
import { SPRINT_ASSESS_CAPS, STORY_ISSUE_IDS, type StoryIssueId } from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';

// The structured-output contract for the sprint assessment's in-process `submit_assessment` tool.
// BUILT from a zod namespace handed in (the AI runtime's own install — review/schema.ts explains why
// a second zod instance silently breaks the SDK's tool schemas).
//
// The shape is deliberately LENIENT (optional where a model may reasonably leave something out),
// EXCEPT text LENGTHS: an over-long sentence is refused by the tool's own schema, so the model rewrites
// it shorter instead of the server clipping it mid-sentence (BMD-1042's summary ended in "…").
// the SERVER validator (validate.ts) is the contract — it enforces caps, issue ids and one entry per
// id, and verifies every cited path against the checkout, dropping a path that does not hold.

type ZodNs = typeof Zod;

export function buildSubmitAssessmentShape(z: ZodNs) {
  return {
    summary: z
      .string()
      .max(SPRINT_ASSESS_CAPS.summary)
      .describe(`One sentence, at most ${SPRINT_ASSESS_CAPS.summary} characters: the single most important finding.`),
    issues: z
      .array(
        z.object({
          id: z
            .enum(STORY_ISSUE_IDS as unknown as [StoryIssueId, ...StoryIssueId[]])
            .describe('Which of the three issues this is.'),
          text: z
            .string()
            .max(SPRINT_ASSESS_CAPS.issueText)
            .describe(`One sentence, at most ${SPRINT_ASSESS_CAPS.issueText} characters, saying what to change.`),
          repo: z.string().optional().describe('owner/name of the repo the file is in, when you cite one.'),
          path: z
            .string()
            .optional()
            .describe('Repo-relative path of a file you opened that backs this, e.g. src/api/users.ts'),
        }),
      )
      .describe('At most one entry per issue, only issues you can back from the ticket or the code.'),
    revisedCriteria: z
      .array(z.string().max(SPRINT_ASSESS_CAPS.criterionText))
      .describe('A better criteria list, one checkable outcome each. Empty to keep them.'),
  };
}
export type SubmitAssessmentShape = ReturnType<typeof buildSubmitAssessmentShape>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitAssessmentShape(): Promise<SubmitAssessmentShape> {
  return buildSubmitAssessmentShape(await loadZod());
}
