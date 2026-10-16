import type { z as Zod } from 'zod';
import { loadZod } from '../../ai/runtime.js';

// The structured-output contract for the sequence-diagram agent's in-process `submit_diagram` tool.
// Built from a zod namespace handed in (the AI runtime's own install — review/schema.ts explains why
// a second zod instance silently breaks the SDK's tool schemas). The SERVER validates `diagram`
// (validate.ts) inside the tool and again before storing.

type ZodNs = typeof Zod;

export function buildSubmitDiagramShape(z: ZodNs) {
  return {
    title: z.string().describe('A few words naming the flow, e.g. "Checkout payment capture".'),
    caption: z
      .string()
      .describe('One to three plain sentences: what the flow does and what this change alters in it.'),
    diagram: z
      .string()
      .describe('The Mermaid source of ONE diagram, starting with its type (prefer sequenceDiagram). No code fence.'),
  };
}

export type SubmitDiagramShape = ReturnType<typeof buildSubmitDiagramShape>;
export type SubmitDiagramPayload = Zod.infer<Zod.ZodObject<SubmitDiagramShape>>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitDiagramShape(): Promise<SubmitDiagramShape> {
  return buildSubmitDiagramShape(await loadZod());
}
