import type { z as Zod } from 'zod';
import { loadZod } from '../../ai/runtime.js';

// ⚠ zod comes from the AI runtime, never a value import — see the note in review/schema.ts.
type ZodNs = typeof Zod;

/**
 * The `submit_resolution` tool's input. Loose on purpose (strings, not enums): an out-of-range
 * value is REFUSED BY `acceptAiChoices` with a reason the agent can act on, rather than rejected
 * by the SDK's schema layer with an error it cannot read.
 */
export function buildSubmitResolutionShape(z: ZodNs) {
  return {
    choices: z
      .array(
        z.object({
          file: z.number(),
          region: z.number(),
          fingerprint: z.string(),
          decision: z.string(),
          lines: z.array(z.string()).optional(),
          rationale: z.string().optional(),
          confidence: z.string().optional(),
        }),
      )
      .max(2000),
    summary: z.string().optional(),
  };
}

export type SubmitResolutionShape = ReturnType<typeof buildSubmitResolutionShape>;
export type SubmitResolutionPayload = Zod.infer<Zod.ZodObject<SubmitResolutionShape>>;

export async function submitResolutionShape(): Promise<SubmitResolutionShape> {
  return buildSubmitResolutionShape(await loadZod());
}
