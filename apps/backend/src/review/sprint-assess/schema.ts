import type { z as Zod } from 'zod';
import {
  SPRINT_ASSESS_CAPS,
  STORY_ISSUE_IDS,
  STORY_QUOTE_MAX,
  STORY_RULES,
  type SprintAssessMode,
  type StoryIssueId,
  type StoryRuleId,
} from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';

// The structured-output contract for the sprint assessment's in-process `submit_assessment` tool.
// BUILT from a zod namespace handed in (the AI runtime's own install — review/schema.ts explains why
// a second zod instance silently breaks the SDK's tool schemas).
//
// The shape is deliberately LENIENT (optional where a model may reasonably leave something out),
// EXCEPT text LENGTHS: an over-long sentence is refused by the tool's own schema, so the model rewrites
// it shorter instead of the server clipping it mid-sentence (BMD-1042's summary ended in "…").
// the SERVER validator (validate.ts) is the contract — it enforces caps, issue ids, the rule
// vocabulary per issue, verifies every QUOTE against the ticket text and every cited path against
// the checkout, dropping a quote or path that does not hold (format 4).

type ZodNs = typeof Zod;

function planShape(z: ZodNs) {
  const C = SPRINT_ASSESS_CAPS;
  return {
    plan: z
      .array(
        z.object({
          repo: z.string().describe('owner/name of the repo the change is in.'),
          path: z
            .string()
            .nullable()
            .optional()
            .describe('An EXISTING repo-relative file or directory the change touches, one you opened or listed.'),
          newPath: z
            .string()
            .nullable()
            .optional()
            .describe('Only for a NEW file: its proposed repo-relative path. Leave out when path is given.'),
          change: z.string().max(C.planChange).describe(`One sentence, at most ${C.planChange} characters: the change, high level.`),
        }),
      )
      .max(C.planSteps)
      .describe(`At most ${C.planSteps} high-level changes needed to deliver the ticket, most important first.`),
  };
}

function verifyShape(z: ZodNs) {
  const C = SPRINT_ASSESS_CAPS;
  return {
    criterionChecks: z
      .array(
        z.object({
          n: z.number().int().min(1).describe('The criterion number.'),
          status: z.enum(['met', 'partly', 'not_met', 'unclear']).describe('Whether the default branch does what the criterion says.'),
          evidence: z.string().max(C.evidence).describe(`One sentence, at most ${C.evidence} characters: what you found.`),
          repo: z.string().optional().describe('owner/name of the repo the file is in.'),
          path: z.string().nullable().optional().describe('Repo-relative path of the file that shows it.'),
          tests: z
            .string()
            .nullable()
            .optional()
            .describe('Repo-relative path of a test file that covers this criterion (same repo), or null when none.'),
        }),
      )
      .max(C.criterionChecks)
      .describe('One entry per numbered criterion, in order.'),
    coverage: z
      .string()
      .max(C.coverage)
      .describe(`One sentence, at most ${C.coverage} characters: which criteria have tests and which do not.`),
  };
}

export function buildSubmitAssessmentShape(z: ZodNs, mode: SprintAssessMode) {
  const rules = STORY_RULES.filter((r) => !r.codeOnly).map((r) => r.id) as [StoryRuleId, ...StoryRuleId[]];
  return {
    summary: z
      .string()
      .max(SPRINT_ASSESS_CAPS.summary)
      .describe(`Two or three short sentences, at most ${SPRINT_ASSESS_CAPS.summary} characters.`),
    ...(mode === 'plan' ? planShape(z) : {}),
    ...(mode === 'verify' ? verifyShape(z) : {}),
    findings: z
      .array(
        z.object({
          issue: z
            .enum(STORY_ISSUE_IDS as unknown as [StoryIssueId, ...StoryIssueId[]])
            .describe('Which of the three issues this is.'),
          rule: z.enum(rules).describe('The rule it breaks — one of the rules listed for its issue.'),
          quote: z
            .string()
            .max(STORY_QUOTE_MAX)
            .nullable()
            .optional()
            .describe(
              `The exact words from the ticket (title, description or criteria) this is about, copied character for character, at most ${STORY_QUOTE_MAX} characters. Null when it is about something the ticket never mentions.`,
            ),
          text: z
            .string()
            .max(SPRINT_ASSESS_CAPS.findingText)
            .describe(`One sentence, at most ${SPRINT_ASSESS_CAPS.findingText} characters, saying what to change.`),
          suggestion: z
            .string()
            .max(SPRINT_ASSESS_CAPS.suggestion)
            .optional()
            .describe(`A rewrite of the quoted words, at most ${SPRINT_ASSESS_CAPS.suggestion} characters. Only with a quote.`),
          repo: z.string().optional().describe('owner/name of the repo the file is in, when you cite one.'),
          path: z
            .string()
            .optional()
            .describe('Repo-relative path of a file you opened that backs this, e.g. src/api/users.ts'),
        }),
      )
      .describe(`At most ${SPRINT_ASSESS_CAPS.findings} findings, only ones you can back from the ticket or the code.`),
    revisedCriteria: z
      .array(z.string().max(SPRINT_ASSESS_CAPS.criterionText))
      .describe('A better criteria list, one checkable outcome each. Empty to keep them.'),
    revisedDescription: z
      .string()
      .max(SPRINT_ASSESS_CAPS.revisedDescription)
      .optional()
      .describe(
        `A rewritten description, at most ${SPRINT_ASSESS_CAPS.revisedDescription} characters. Only when the description itself should change; leave it out otherwise.`,
      ),
  };
}
export type SubmitAssessmentShape = ReturnType<typeof buildSubmitAssessmentShape>;

/** The raw shape `tool()` wants for one mode, built from the runtime's zod. */
export async function submitAssessmentShape(mode: SprintAssessMode): Promise<SubmitAssessmentShape> {
  return buildSubmitAssessmentShape(await loadZod(), mode);
}
