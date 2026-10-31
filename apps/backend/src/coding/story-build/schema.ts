import type { z as Zod } from 'zod';
import {
  STORY_BUILD_MAX_REPOS,
  STORY_BUILD_MAX_RISKS,
  STORY_BUILD_MAX_STEPS_PER_REPO,
  STORY_BUILD_STEP_TITLE_MAX,
  STORY_BUILD_SUMMARY_MAX_SENTENCES,
  STORY_BUILD_SUMMARY_MIN_SENTENCES,
} from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';
import { buildFlowShape } from '../../review/diagrams/schema.js';

// The `submit_story_plan` tool's contract (the read-only `story_plan` pass, docs/STORY-BUILD.md), built
// from a zod handed in (the AI runtime's own install — review/schema.ts explains why a second zod
// instance silently breaks the SDK's tool schemas). Codex gets the STRICT form of the same shape
// (ai/result-schemas.ts `submit_story_plan`).
//
// ⚠ DELIBERATELY LOOSE (the diagrams/schema.ts rule): plain strings and arrays, no enums, no lengths.
// The server's judge (plan.ts `checkStoryPlanSubmission`) answers WITH WHAT TO FIX; a zod refusal
// would fail before the handler with a schema error the model reads far less well.

type ZodNs = typeof Zod;

export function buildSubmitStoryPlanShape(z: ZodNs) {
  return {
    summary: z
      .string()
      .describe(`${STORY_BUILD_SUMMARY_MIN_SENTENCES}-${STORY_BUILD_SUMMARY_MAX_SENTENCES} plain sentences: what this build will do.`),
    repos: z
      .array(
        z.object({
          ref: z.string().describe('The repository ref from REPOSITORIES (R1, R2, …).'),
          why: z.string().describe('One sentence: why this repository changes.'),
          branchSlug: z.string().describe('A few lower-case words joined by hyphens for the branch name.'),
          steps: z
            .array(
              z.object({
                title: z.string().describe(`A few words (at most ${STORY_BUILD_STEP_TITLE_MAX} characters).`),
                files: z.array(z.string()).describe('Paths relative to that repository root.'),
                change: z.string().describe('What will change and why, a few sentences.'),
                refs: z.array(z.string()).describe('The gap refs this step closes (AC2, M1), exactly as given; [] when none.'),
              }),
            )
            .describe(`1-${STORY_BUILD_MAX_STEPS_PER_REPO} steps, in the order they will be built.`),
          tests: z.array(z.string()).describe('Tests to add or change, one line each ([] when none).'),
        }),
      )
      .describe(`The repositories that CHANGE, 1-${STORY_BUILD_MAX_REPOS}, in the order they should be built.`),
    readOnlyRepos: z
      .array(z.object({ ref: z.string(), why: z.string().describe('One sentence: what it is read for.') }))
      .optional()
      .describe('Repositories read for context that do not change.'),
    criteria: z
      .array(
        z.object({
          ref: z.string().describe('A gap ref (AC2, M1), exactly as given.'),
          how: z.string().describe('One of: existing, planned, not_planned.'),
          repo: z.string().nullable().optional().describe('planned: the changed repository ref whose steps close it.'),
          reason: z.string().nullable().optional().describe('existing / not_planned: one sentence why.'),
        }),
      )
      .describe('Every gap you were given, exactly once.'),
    risks: z.array(z.string()).optional().describe(`At most ${STORY_BUILD_MAX_RISKS} risks, one sentence each.`),
    reply: z
      .string()
      .nullable()
      .optional()
      .describe('When the person sent a steering message: one or two sentences on what you changed because of it.'),
    design: z
      .object(buildFlowShape(z))
      .nullable()
      .optional()
      .describe('Only when asked for a design: the planned data flow, participants and steps naming repository refs (R1…) in `pr`. Otherwise null.'),
  };
}

export type SubmitStoryPlanShape = ReturnType<typeof buildSubmitStoryPlanShape>;

export async function submitStoryPlanShape(): Promise<SubmitStoryPlanShape> {
  return buildSubmitStoryPlanShape(await loadZod());
}
