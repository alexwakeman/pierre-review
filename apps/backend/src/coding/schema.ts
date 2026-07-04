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
