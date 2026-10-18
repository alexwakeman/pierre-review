import type { z as Zod } from 'zod';
import {
  STORY_DOCS_ACTION_MAX,
  STORY_DOCS_ACTIONS_MAX,
  STORY_DOCS_ACTIONS_MIN,
  STORY_DOCS_DERIVED_CRITERIA_MAX,
  STORY_DOCS_ITEM_VERDICTS,
  STORY_DOCS_NOTE_MAX,
  STORY_DOCS_OVERALL_VERDICTS,
  STORY_DOCS_PART_LABEL_MAX,
  STORY_DOCS_QUOTE_MAX,
  STORY_DOCS_REFS_PER_ITEM_MAX,
  STORY_DOCS_STORY_PARTS_MAX,
  REVIEW_DOC_QUOTE_MIN_CHARS,
} from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';

// The `submit_alignment` tool's contract, built from a zod handed in (the AI runtime's own install —
// review/schema.ts explains why a second zod instance silently breaks the SDK's tool schemas).
//
// ⚠ DELIBERATELY LOOSE (the diagrams/schema.ts rule): plain strings, numbers and arrays, no enums, no
// max lengths. The server's judge (validate.ts) replies with WHAT TO FIX; a zod refusal would fail
// before the handler with a schema error the model reads far less well.

type ZodNs = typeof Zod;

export function buildSubmitAlignmentShape(z: ZodNs) {
  const ref = z.object({
    link: z.string().describe("The section's link from the library root, with the heading's anchor when you can: 'billing-handbook/sections/04-refunds.md#partial-refunds'."),
    quote: z.string().describe(`Words copied EXACTLY from that section: at least ${REVIEW_DOC_QUOTE_MIN_CHARS} letters, at most ${STORY_DOCS_QUOTE_MAX} characters. Use … to skip words.`),
  });
  const refs = z.array(ref).describe(`1-${STORY_DOCS_REFS_PER_ITEM_MAX} passages this point rests on.`);
  return {
    overall: z
      .object({
        verdict: z.string().describe(`One of: ${STORY_DOCS_OVERALL_VERDICTS.join(', ')}.`),
        summary: z.string().describe('2-3 plain sentences: how the story as a whole lines up with the docs.'),
        actions: z
          .array(z.object({ text: z.string().describe(`One actionable step, one sentence, at most ${STORY_DOCS_ACTION_MAX} characters.`), refs }))
          .describe(`${STORY_DOCS_ACTIONS_MIN}-${STORY_DOCS_ACTIONS_MAX} things to do about the story.`),
      })
      .describe('The story as a whole.'),
    criteria: z
      .array(
        z.object({
          n: z.number().describe('The criterion number.'),
          verdict: z.string().describe(`One of: ${STORY_DOCS_ITEM_VERDICTS.join(', ')}.`),
          note: z.string().describe(`One or two sentences, at most ${STORY_DOCS_NOTE_MAX} characters.`),
          refs,
        }),
      )
      .optional()
      .describe('Only the criteria the docs say something about.'),
    storyParts: z
      .array(
        z.object({
          part: z.string().describe(`Which part of the story, in a few words (at most ${STORY_DOCS_PART_LABEL_MAX} characters).`),
          verdict: z.string().describe(`One of: ${STORY_DOCS_ITEM_VERDICTS.join(', ')}.`),
          note: z.string().describe(`One or two sentences, at most ${STORY_DOCS_NOTE_MAX} characters.`),
          refs,
        }),
      )
      .optional()
      .describe(`Up to ${STORY_DOCS_STORY_PARTS_MAX} points on parts of the story that are not one criterion.`),
    derivedCriteria: z
      .array(z.string())
      .optional()
      .describe(`Only when told to work the criteria out: up to ${STORY_DOCS_DERIVED_CRITERIA_MAX}, one sentence each.`),
  };
}

export type SubmitAlignmentShape = ReturnType<typeof buildSubmitAlignmentShape>;
export type SubmitAlignmentPayload = Zod.infer<Zod.ZodObject<SubmitAlignmentShape>>;

export async function submitAlignmentShape(): Promise<SubmitAlignmentShape> {
  return buildSubmitAlignmentShape(await loadZod());
}
