import { z } from 'zod';

// The structured-output contract for the in-process `submit_fix` MCP tool. The agent
// EDITS files in the worktree and calls this ONCE at the end to report what it did.
// We deliberately capture ONLY a prose summary + a commit message here — the actual
// changeset (patch + file list) is derived from `git` after the run, never from the
// agent's self-report (which miscounts / omits files). Exported as a raw zod shape
// (what `tool()` wants) plus an assembled object schema for validation.
export const submitFixShape = {
  // A concise, user-facing description of the fix that was applied.
  summary: z.string(),
  // A conventional-commit-style message for the commit the host will create.
  commitMessage: z.string(),
  // OPTIONAL per-item dispositions, for a run that was seeded with a LIST of things to work
  // through (today: the "fix from comments" seed, where each entry is one review comment the
  // user picked). The caller's prompt is what assigns the `ref` labels and asks for these; a
  // plain / CI-seeded run leaves this absent, which is why it must stay optional — an agent
  // that has no list to report on should not be made to invent one.
  //
  // As with `summary`, this is the agent's SELF-REPORT and is stored as commentary, never as
  // the changeset: `filesTouched` is advisory and the authoritative diff still comes from git.
  commentVerdicts: z
    .array(
      z.object({
        // The label from the prompt (e.g. "C3"). The caller maps it back to a real comment.
        ref: z.string(),
        verdict: z.enum([
          'fixed',
          'partially_fixed',
          'already_addressed',
          'invalid',
          'out_of_scope',
          'needs_human',
        ]),
        // Whether the comment was technically correct, independent of whether it was acted on.
        valid: z.boolean(),
        reasoning: z.string(),
        // An argued rebuttal — set ONLY when disagreeing with the comment.
        pushback: z.string().optional(),
        // A durable takeaway about this reviewer's comment, if any.
        learning: z.string().optional(),
        filesTouched: z.array(z.string()).optional(),
      }),
    )
    .optional(),
};

export const submitFixSchema = z.object(submitFixShape);

export type SubmitFixPayload = z.infer<typeof submitFixSchema>;

// The structured-output contract for the in-process `submit_resolution` MCP tool.
// The agent edits the conflicted files in a mid-merge/mid-rebase worktree to remove
// every conflict, then calls this ONCE. As with submit_fix, the actual resolution is
// derived from `git` (unmerged paths / leftover markers), never the agent's word —
// this is only a short human-readable note of how the conflicts were reconciled.
export const submitResolutionShape = {
  summary: z.string(),
};

export const submitResolutionSchema = z.object(submitResolutionShape);

export type SubmitResolutionPayload = z.infer<typeof submitResolutionSchema>;
