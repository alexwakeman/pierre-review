import type { z as Zod } from "zod";
import { loadZod } from "../ai/runtime.js";

// ⚠ zod is NOT imported here as a value. It comes from the AI runtime (ai/runtime.ts), the SAME
// install the Agent SDK uses — a second zod instance silently breaks the SDK's tool-schema
// conversion, and on an npm install zod exists only once the reader has set AI up. So the shape is
// BUILT from a zod namespace handed in, and `submitReviewShape()` builds it from the runtime's.
type ZodNs = typeof Zod;

// The structured-output contract for the in-process `submit_review` MCP tool.
// Exported as a raw zod shape (what `tool()` wants) plus an assembled object
// schema (for validation in tests / belt-and-suspenders parsing).
//
// ⚠ EVERY FOLLOW-UP / REVIEW-THREAD FIELD IS OPTIONAL, so a run with none of those sections
// submits exactly the old shape and validates exactly as before. The prompt — not this schema —
// requires `followUp` / `threads` when the user message carries those sections, and
// the server reconciles whatever arrives (missing refs become 'not_checked'). 'not_checked' is in
// NO enum here: only the server writes it.
//
// There is NO `tickets` field: user stories left the PR review for the ticket review
// (review/ticket-review/, its own `submit_ticket_review`). A stray `tickets` key is stripped by
// zod's default object parsing, so nothing a model sends here can become a story verdict.
//
// There is NO `ciFailures` field either: failing CI left the PR review for the CI review
// (review/ci-review/, its own `submit_ci_review`). A stray `ciFailures` key is stripped the same way.

export function buildSubmitReviewShape(z: ZodNs) {
  return {
    summary: z.string(),
    verdict: z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]),
    scopeUsed: z.enum(["diff_only", "worktree"]),
    findings: z.array(
      z.object({
        path: z.string(),
        // null/omitted ⇒ file-level / unanchored finding.
        line: z.number().int().nullable().optional(),
        side: z.enum(["LEFT", "RIGHT"]).optional(),
        // No 'praise': a review posts only what needs the author's attention. What is good goes in
        // ONE "Good:" line of the summary instead. Stored praise rows on older runs stay readable
        // (the shared ClaudeFindingSeverity keeps the member) and are hidden on every read.
        severity: z.enum(["blocker", "warning", "nit", "question"]),
        title: z.string(),
        body: z.string(),
        suggestion: z.string().nullable().optional(),
        priorRef: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Only when this finding raises a finding from the 'Previous review' section again: its ref, e.g. 'P3'. Leave it out otherwise.",
          ),
        lens: z
          .enum(["design", "tests", "impact", "accessibility", "security", "performance"])
          .nullable()
          .optional()
          .describe(
            "Deep reviews only: the specialist angle this finding comes from ('design' for an architecture-level comment). Leave it out for a general finding.",
          ),
      }),
    ),
    followUp: z
      .array(
        z.object({
          ref: z.string().describe("The previous finding's ref, e.g. 'P1'."),
          status: z.enum([
            "addressed",
            "partly_addressed",
            "not_addressed",
            "no_longer_applies",
          ]),
          explanation: z
            .string()
            .describe(
              "One or two sentences naming what changed, or saying that nothing did.",
            ),
        }),
      )
      .optional()
      .describe(
        "One entry per finding in the 'Previous review' section, each ref at most once. Leave out a ref whose code you cannot see rather than guess. Leave the whole field out when there is no such section.",
      ),
    threads: z
      .array(
        z.object({
          ref: z.string().describe("The thread's ref from the 'Review threads' section, e.g. 'R2'."),
          validity: z.enum(["valid", "partly_valid", "not_valid", "unclear"]),
          addressed: z.enum(["addressed", "partly_addressed", "not_addressed", "unclear"]),
          explanation: z
            .string()
            .describe("One or two sentences that name the code you checked."),
          draftReply: z
            .string()
            .nullable()
            .optional()
            .describe("Optional: a short reply the author could post on the thread."),
        }),
      )
      .optional()
      .describe(
        "Only when the user message has a 'Review threads' section: one entry per thread there, each ref once. Leave out a ref whose code you cannot see rather than guess. Leave the whole field out otherwise.",
      ),
  };
}

export type SubmitReviewShape = ReturnType<typeof buildSubmitReviewShape>;
export type SubmitReviewPayload = Zod.infer<Zod.ZodObject<SubmitReviewShape>>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitReviewShape(): Promise<SubmitReviewShape> {
  return buildSubmitReviewShape(await loadZod());
}

/** The assembled object schema, for validation. */
export async function submitReviewSchema(): Promise<
  Zod.ZodObject<SubmitReviewShape>
> {
  const z = await loadZod();
  return z.object(buildSubmitReviewShape(z));
}
