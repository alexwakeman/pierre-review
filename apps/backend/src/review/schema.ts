import { z } from 'zod';

// The structured-output contract for the in-process `submit_review` MCP tool.
// Exported as a raw zod shape (what `tool()` wants) plus an assembled object
// schema (for validation in tests / belt-and-suspenders parsing).
export const submitReviewShape = {
  summary: z.string(),
  verdict: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
  scopeUsed: z.enum(['diff_only', 'worktree']),
  findings: z.array(
    z.object({
      path: z.string(),
      // null/omitted ⇒ file-level / unanchored finding.
      line: z.number().int().nullable().optional(),
      side: z.enum(['LEFT', 'RIGHT']).optional(),
      severity: z.enum(['blocker', 'warning', 'nit', 'question', 'praise']),
      title: z.string(),
      body: z.string(),
      suggestion: z.string().nullable().optional(),
    }),
  ),
};

export const submitReviewSchema = z.object(submitReviewShape);

export type SubmitReviewPayload = z.infer<typeof submitReviewSchema>;
