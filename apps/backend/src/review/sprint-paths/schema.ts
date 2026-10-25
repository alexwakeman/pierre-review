import type { z as Zod } from 'zod';
import { SPRINT_PATHS_CAPS } from '@pierre-review/shared';

// The `submit_paths` tool's shape (moved out of agent.ts unchanged, so the provider seam's strict
// result schema — ai/result-schemas.ts — is built from the SAME shape the Claude tool uses).
//
// ⚠ DELIBERATELY LOOSE: plain strings and arrays. The SERVER's validator judges the answer inside
// the tool and replies with what to fix; a zod refusal reads far worse to the model.
//
// zod is never imported here as a value: the shape is BUILT from the AI runtime's zod (the SAME
// install the Agent SDK uses), handed in.
type ZodNs = typeof Zod;

export function buildSubmitPathsShape(z: ZodNs) {
  return {
    paths: z
      .array(
        z.object({
          title: z.string(),
          tickets: z.array(z.string()).describe('ticket keys from the map, in the order the work must happen'),
          advice: z.string().describe('one plain sentence, no digits'),
          risk: z.string().describe('high, medium or low'),
        }),
      )
      .describe(`at most ${SPRINT_PATHS_CAPS.maxPaths}, riskiest first`),
    callouts: z
      .array(z.object({ title: z.string(), tickets: z.array(z.string()) }))
      .describe(`at most ${SPRINT_PATHS_CAPS.maxCallouts}`),
  };
}
