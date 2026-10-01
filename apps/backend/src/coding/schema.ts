import type { z as Zod } from "zod";
import { loadZod } from "../ai/runtime.js";

// ⚠ zod comes from the AI runtime, never a value import — see the note in review/schema.ts.
type ZodNs = typeof Zod;

// The structured-output contract for the in-process `submit_fix` MCP tool. The agent
// EDITS files in the worktree and calls this ONCE at the end to report what it did.
// We deliberately capture ONLY a prose summary + a commit message here — the actual
// changeset (patch + file list) is derived from `git` after the run, never from the
// agent's self-report (which miscounts / omits files). Exported as a raw zod shape
// (what `tool()` wants) plus an assembled object schema for validation.
export function buildSubmitFixShape(z: ZodNs) {
  return {
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
            "fixed",
            "partially_fixed",
            "already_addressed",
            "invalid",
            "out_of_scope",
            "needs_human",
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
}

export type SubmitFixShape = ReturnType<typeof buildSubmitFixShape>;
export type SubmitFixPayload = Zod.infer<Zod.ZodObject<SubmitFixShape>>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitFixShape(): Promise<SubmitFixShape> {
  return buildSubmitFixShape(await loadZod());
}

/** The assembled object schema, for validation. */
export async function submitFixSchema(): Promise<
  Zod.ZodObject<SubmitFixShape>
> {
  const z = await loadZod();
  return z.object(buildSubmitFixShape(z));
}
