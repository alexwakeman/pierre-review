import type { z as Zod } from 'zod';
import {
  DESIGN_ACT_TITLE_MAX,
  DESIGN_ARROW_LABEL_MAX,
  DESIGN_CAPTION_MAX,
  DESIGN_CELL_FILES_MAX,
  DESIGN_CELL_LABEL_MAX,
  DESIGN_CHANGES,
  DESIGN_LAYER_ORDER,
  DESIGN_MAX_ACTS,
  DESIGN_MAX_ARROWS,
  DESIGN_MAX_CELLS,
  DESIGN_MAX_LAYERS,
  DESIGN_PATTERN_MAX,
  DESIGN_TITLE_MAX,
} from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';

// The structured-output contract for the design agent's in-process `submit_design` tool. Built from a
// zod namespace handed in (the AI runtime's own install — review/schema.ts explains why a second zod
// instance silently breaks the SDK's tool schemas).
//
// ⚠ DELIBERATELY LOOSE: plain strings and arrays, no enums, no max lengths. The SERVER's validator
// (validate.ts) judges the answer inside the tool and replies with WHAT TO FIX ("5 acts; merge two…");
// a zod refusal would fail before the handler with a schema error the model reads far less well.

type ZodNs = typeof Zod;

export function buildSubmitDesignShape(z: ZodNs) {
  return {
    title: z.string().describe(`A few words naming what the change builds (at most ${DESIGN_TITLE_MAX} characters).`),
    caption: z
      .string()
      .describe(`At most two short plain sentences (${DESIGN_CAPTION_MAX} characters): the design in a nutshell.`),
    acts: z
      .array(z.object({ id: z.string(), title: z.string() }))
      .describe(`1-${DESIGN_MAX_ACTS} stages, left to right; titles at most ${DESIGN_ACT_TITLE_MAX} characters.`),
    layers: z
      .array(z.string())
      .describe(`1-${DESIGN_MAX_LAYERS} of: ${DESIGN_LAYER_ORDER.join(', ')} — only layers that have a cell.`),
    cells: z
      .array(
        z.object({
          id: z.string(),
          act: z.string().describe('An act id.'),
          layer: z.string().describe('A layer id from `layers`.'),
          label: z.string().describe(`The responsibility, at most ${DESIGN_CELL_LABEL_MAX} characters.`),
          pattern: z.string().nullable().optional().describe(`The pattern used, at most ${DESIGN_PATTERN_MAX} characters.`),
          change: z.string().describe(`One of: ${DESIGN_CHANGES.join(', ')}.`),
          pr: z.string().nullable().optional().describe('Story designs: the PR ref (PR1, PR2, …). Otherwise null.'),
          files: z.array(z.string()).optional().describe(`Up to ${DESIGN_CELL_FILES_MAX} changed file paths.`),
        }),
      )
      .describe(`At most ${DESIGN_MAX_CELLS} cells, at most one per (act, layer).`),
    arrows: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          label: z.string().nullable().optional().describe(`At most 3 words (${DESIGN_ARROW_LABEL_MAX} characters).`),
        }),
      )
      .describe(`At most ${DESIGN_MAX_ARROWS} arrows between cell ids.`),
  };
}

export type SubmitDesignShape = ReturnType<typeof buildSubmitDesignShape>;
export type SubmitDesignPayload = Zod.infer<Zod.ZodObject<SubmitDesignShape>>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitDesignShape(): Promise<SubmitDesignShape> {
  return buildSubmitDesignShape(await loadZod());
}
