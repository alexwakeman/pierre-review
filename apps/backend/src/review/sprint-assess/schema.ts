import type { z as Zod } from 'zod';
import { SPRINT_ASSESS_CAPS, type SprintAssessMode } from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';
import { buildDocReferencesField } from '../../reference-docs/review-refs.js';

// The structured-output contract for the sprint assessment's in-process `submit_assessment` tool.
// BUILT from a zod namespace handed in (the AI runtime's own install — review/schema.ts explains why
// a second zod instance silently breaks the SDK's tool schemas).
//
// The shape is deliberately LENIENT (optional where a model may reasonably leave something out),
// EXCEPT text LENGTHS: an over-long sentence is refused by the tool's own schema, so the model rewrites
// it shorter instead of the server clipping it mid-sentence (BMD-1042's summary ended in "…").
// the SERVER validator (validate.ts) is the contract — it enforces caps and verifies every cited
// path against the checkout, dropping a path that does not hold. Format 6: no findings, no revisions.

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

// `opts.docs`: the run reads the workspace's reference library (docs/REFERENCE-DOCS.md § Use in
// reviews) and the shape gains `docReferences`. Without it the shape is exactly the base one.
export function buildSubmitAssessmentShape(z: ZodNs, mode: SprintAssessMode, opts: { docs?: boolean } = {}) {
  const base = buildBaseAssessmentShape(z, mode);
  return opts.docs ? { ...base, docReferences: buildDocReferencesField(z) } : base;
}

function buildBaseAssessmentShape(z: ZodNs, mode: SprintAssessMode) {
  return {
    summary: z
      .string()
      .max(SPRINT_ASSESS_CAPS.summary)
      .describe(`Two or three short sentences, at most ${SPRINT_ASSESS_CAPS.summary} characters.`),
    ...(mode === 'plan' ? planShape(z) : {}),
    ...(mode === 'verify' ? verifyShape(z) : {}),
  };
}
export type SubmitAssessmentShape = ReturnType<typeof buildSubmitAssessmentShape>;

/** The raw shape `tool()` wants for one mode, built from the runtime's zod. */
export async function submitAssessmentShape(mode: SprintAssessMode, opts: { docs?: boolean } = {}): Promise<SubmitAssessmentShape> {
  return buildSubmitAssessmentShape(await loadZod(), mode, opts);
}
