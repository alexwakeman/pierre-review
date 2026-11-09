import type { z as Zod } from 'zod';

// The `submit_replies` shape of a REPLIES PASS (replies-check.ts), in its own module so the provider
// seam's result-schema registry (ai/result-schemas.ts) can build Codex's strict form from it without
// importing the run. One entry per thread: the same three answers a review's follow-up gives a reply
// (follow-up.ts `judgeReplyReport` is the gate over them), plus "not checked" — and, for a COVER
// PASS, the review follow-up's four code statuses (follow-up.ts `reconcileFollowUp` is the gate).

type ZodNs = typeof Zod;

export function buildSubmitRepliesShape(z: ZodNs) {
  return {
    replies: z
      .array(
        z.object({
          ref: z.string().describe("The thread's ref, e.g. 'T1'."),
          // The four code statuses are a COVER PASS's only (replies-check.ts `startCoverCheck`): it
          // checks earlier findings against the code, not just replies. A replies pass stores them as
          // not_checked (replies-pass.ts `reconcileReplies`).
          status: z
            .enum([
              'reply_accepted',
              'reply_disputed',
              'addressed',
              'partly_addressed',
              'not_addressed',
              'no_longer_applies',
              'not_checked',
            ])
            .describe(
              "reply_accepted: the reply is reasonable. reply_disputed: it does not hold up. addressed / partly_addressed / not_addressed / no_longer_applies: only when the message asks whether the code deals with each finding. not_checked: you could not judge it.",
            ),
          acceptKind: z
            .enum(['not_valid', 'deferred'])
            .nullable()
            .optional()
            .describe(
              "Only with reply_accepted: 'not_valid' when the reply shows the finding was wrong or does not apply, 'deferred' when it promises a reasonable later fix.",
            ),
          reply: z
            .string()
            .max(600)
            .nullable()
            .optional()
            .describe(
              'Only with a reply_ status: for reply_accepted ONE sentence acknowledging it; for reply_disputed a short, polite, specific pushback that names the code.',
            ),
          explanation: z
            .string()
            .max(1000)
            .nullable()
            .optional()
            .describe('One or two sentences naming the code you checked.'),
          replyRef: z
            .string()
            .nullable()
            .optional()
            .describe(
              "Only with a reply_ status on a finding posted as a PR comment: the ref (C1, C2, …) of the PR comment that answers it.",
            ),
          // No `.max()`: the server clips it (shared `oneLineHow`), so a long line never rejects the call.
          how: z
            .string()
            .nullable()
            .optional()
            .describe(
              'ONE line, at most 120 characters. reply_accepted: the reason you accepted. reply_disputed, not_addressed or partly_addressed: the one thing still needed to resolve it. addressed or no_longer_applies: how it was dealt with.',
            ),
        }),
      )
      .describe('One entry per thread in the message, each ref once.'),
  };
}
