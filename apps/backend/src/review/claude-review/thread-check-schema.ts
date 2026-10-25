import type { z as Zod } from 'zod';
import { buildThreadReportItem } from '../schema.js';

// The `submit_threads` shape, in its own module (moved out of thread-check-agent.ts unchanged, which
// re-exports it) so the provider seam's result-schema registry (ai/result-schemas.ts) can build it
// without importing the agent run and everything behind it.

type ZodNs = typeof Zod;

/** The `submit_threads` shape: the review's own thread item (review/schema.ts), so they never drift. */
export function buildSubmitThreadsShape(z: ZodNs) {
  return {
    threads: z
      .array(buildThreadReportItem(z))
      .describe("One entry per thread in the 'Review threads' section, each ref once. Leave out a ref you cannot judge."),
  };
}
