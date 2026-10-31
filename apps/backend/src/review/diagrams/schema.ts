import type { z as Zod } from 'zod';
import {
  DESIGN_CAPTION_MAX,
  DESIGN_CHANGES,
  DESIGN_TITLE_MAX,
  FLOW_DECLINE_MAX,
  FLOW_LANE_KINDS,
  FLOW_MAX_PARTICIPANTS,
  FLOW_MAX_STEPS,
  FLOW_PARTICIPANT_LABEL_MAX,
  FLOW_STEP_FILES_MAX,
  FLOW_STEP_KINDS,
  FLOW_STEP_LABEL_MAX,
} from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';

// The structured-output contract for the design agent's in-process `submit_design` tool: a DATA-FLOW
// SEQUENCE (packages/shared `FlowDiagram`). Built from a zod namespace handed in (the AI runtime's own
// install — review/schema.ts explains why a second zod instance silently breaks the SDK's tool schemas).
// Codex gets the STRICT form of the same shape (ai/result-schemas.ts `submit_design`).
//
// ⚠ DELIBERATELY LOOSE: plain strings and arrays, no enums, no max lengths. The SERVER's validator
// (validate.ts) judges the answer inside the tool and replies with WHAT TO FIX ("step 4 starts at …");
// a zod refusal would fail before the handler with a schema error the model reads far less well.
//
// `noDiagram` is the model's way to say the change has no data path (a rename, a copy edit, a config
// value). Only the PR and story designs offer it (`buildSubmitDesignShape`); the story build's PLANNED
// design (the reader asked for one) takes the flow alone (`buildFlowShape`).

type ZodNs = typeof Zod;

/** The flow itself: title, caption, participants and steps. */
export function buildFlowShape(z: ZodNs) {
  return {
    title: z.string().describe(`A few words naming what the change does to the data (at most ${DESIGN_TITLE_MAX} characters).`),
    caption: z
      .string()
      .describe(`At most two short plain sentences (${DESIGN_CAPTION_MAX} characters): the flow in a nutshell.`),
    participants: z
      .array(
        z.object({
          id: z.string(),
          kind: z.string().describe(`One of: ${FLOW_LANE_KINDS.join(', ')}.`),
          label: z.string().describe(`What it is, at most ${FLOW_PARTICIPANT_LABEL_MAX} characters ("Orders route", "orders table").`),
          change: z.string().describe(`One of: ${DESIGN_CHANGES.join(', ')}.`),
          pr: z.string().nullable().optional().describe('Story designs: the ref that builds it (PR1, PR2, …). Otherwise null.'),
        }),
      )
      .describe(`2-${FLOW_MAX_PARTICIPANTS} lanes, left to right in the order the data first reaches them.`),
    steps: z
      .array(
        z.object({
          n: z.number().describe('The step number: 1, 2, 3, … in process order.'),
          from: z.string().describe('A participant id.'),
          to: z.string().describe('A participant id (the same one only for validate or transform).'),
          kind: z.string().describe(`One of: ${FLOW_STEP_KINDS.join(', ')}.`),
          label: z.string().describe(`WHAT data passes or is checked, at most ${FLOW_STEP_LABEL_MAX} characters.`),
          pr: z.string().nullable().optional().describe('Story designs: the ref that does this step (PR1, PR2, …). Otherwise null.'),
          files: z.array(z.string()).optional().describe(`Up to ${FLOW_STEP_FILES_MAX} changed file paths whose code performs this step.`),
        }),
      )
      .describe(`At most ${FLOW_MAX_STEPS} steps, in order; each starts where the data already is.`),
  };
}

/** `submit_design`: the flow, or `noDiagram` with a reason. */
export function buildSubmitDesignShape(z: ZodNs) {
  return {
    ...buildFlowShape(z),
    noDiagram: z
      .string()
      .nullable()
      .optional()
      .describe(
        `Only when no data moves through the change: why, finishing the sentence "No diagram: …" (at most ${FLOW_DECLINE_MAX} characters), with participants and steps empty. Otherwise null.`,
      ),
  };
}

export type SubmitDesignShape = ReturnType<typeof buildSubmitDesignShape>;
export type SubmitDesignPayload = Zod.infer<Zod.ZodObject<SubmitDesignShape>>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitDesignShape(): Promise<SubmitDesignShape> {
  return buildSubmitDesignShape(await loadZod());
}
