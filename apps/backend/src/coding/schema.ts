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
    // The per-change report: ONE entry per file the agent changed — what changed and why, and the
    // refs of the task items (F3, T1, S1-AC2, C1, P2 …) that change addresses. Optional at the
    // schema level so a run that changed nothing is not made to invent one; the prompt asks for it.
    // As with `summary`, this is a SELF-REPORT stored as commentary: the authoritative changeset
    // still comes from git, and the manager drops any ref the run was not shown.
    changes: z
      .array(
        z.object({
          path: z.string(),
          // 1–3 sentences: what changed and why.
          summary: z.string(),
          refs: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    // Items the agent deliberately did NOT fix, each with the reason (wrong, out of scope, needs
    // a person, already done …).
    unaddressed: z
      .array(z.object({ ref: z.string(), reason: z.string() }))
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
