import type { z as Zod } from 'zod';
import { loadZod } from '../ai/runtime.js';

// The build agent's in-process tools (`mcp__docs__*`), built from the AI runtime's own zod (see
// review/schema.ts for why a second zod instance silently breaks the SDK's tool schemas). The SERVER
// judges every call (build-judge.ts) and answers a refusal with what to fix.

type ZodNs = typeof Zod;

export function buildRecordSectionsShape(z: ZodNs) {
  return {
    sections: z
      .array(
        z.object({
          file: z.string().describe('The section file name, e.g. "003-payment-terms.md".'),
          title: z.string().optional().describe('The section heading. PDF builds: required.'),
          summary: z
            .string()
            .describe('ONE line (max 200 characters): what this section says — its specific rules, facts, names or numbers.'),
          depth: z
            .number()
            .int()
            .optional()
            .describe('PDF builds: 1 = a chapter or top heading, 2 = a section inside it, and so on.'),
        }),
      )
      .describe('One entry per section file, in reading order.'),
  };
}

export function buildFinishShape(z: ZodNs) {
  return {
    title: z.string().optional().describe('The document\'s real title, when the file name is not it.'),
    summary: z.string().describe('One or two sentences: what the whole document is and what it governs.'),
    topics: z.array(z.string()).describe('3 to 12 key topics, a few words each.'),
  };
}

export type RecordSectionsShape = ReturnType<typeof buildRecordSectionsShape>;
export type FinishShape = ReturnType<typeof buildFinishShape>;
export type RecordSectionsPayload = Zod.infer<Zod.ZodObject<RecordSectionsShape>>;
export type FinishPayload = Zod.infer<Zod.ZodObject<FinishShape>>;

export async function buildToolShapes(): Promise<{ record: RecordSectionsShape; finish: FinishShape; empty: Record<string, never> }> {
  const z = await loadZod();
  return { record: buildRecordSectionsShape(z), finish: buildFinishShape(z), empty: {} };
}
