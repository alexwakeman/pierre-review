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
// ⚠ EVERY FOLLOW-UP / USER-STORY FIELD IS OPTIONAL, so a run with no previous review and no user
// story submits exactly the old shape and validates exactly as before. The prompt — not this
// schema — requires `followUp` / `ticket` when the user message carries those sections, and the
// plugin reconciles whatever arrives (missing refs become 'not_checked'). 'not_checked' is in NO
// enum here: only the server writes it.

export function buildSubmitReviewShape(z: ZodNs) {
  const ticketGap = z.object({
    title: z.string().describe("A short name for the gap."),
    explanation: z.string().describe("One or two sentences."),
    path: z
      .string()
      .nullable()
      .optional()
      .describe("The file that shows it, if any."),
    line: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("The line that shows it, if any."),
  });

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
        severity: z.enum(["blocker", "warning", "nit", "question", "praise"]),
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
    ticket: z
      .object({
        alignment: z.enum([
          "aligned",
          "partly_aligned",
          "not_aligned",
          "unclear",
        ]),
        summary: z
          .string()
          .describe(
            "One or two sentences on how well the change matches the user story.",
          ),
        criteria: z
          .array(
            z.object({
              text: z
                .string()
                .describe(
                  "The criterion in one short sentence, as you read it from the acceptance criteria.",
                ),
              status: z.enum(["met", "partly_met", "not_met", "unclear"]),
              explanation: z.string(),
              path: z.string().nullable().optional(),
              line: z.number().int().nullable().optional(),
            }),
          )
          .optional()
          .describe(
            "Every distinct acceptance criterion you find in the acceptance-criteria text, in the order it appears, each once. Leave it out when there is no acceptance-criteria text.",
          ),
        missing: z
          .array(ticketGap)
          .optional()
          .describe(
            "What the user story asks for that the change does not do and no criterion covers.",
          ),
        notRequested: z
          .array(ticketGap)
          .optional()
          .describe(
            "What the change adds that the user story did not ask for.",
          ),
      })
      .optional()
      .describe(
        "Only when the user message has a 'User story or task' section. Leave it out otherwise.",
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
