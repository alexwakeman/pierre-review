import type { z as Zod } from 'zod';

// The `submit_replies` shape of a REPLIES PASS (replies-check.ts), in its own module so the provider
// seam's result-schema registry (ai/result-schemas.ts) can build Codex's strict form from it without
// importing the run. One entry per thread: the same three answers a review's follow-up gives a reply
// (follow-up.ts `judgeReplyReport` is the gate over them), plus "not checked".

type ZodNs = typeof Zod;

export function buildSubmitRepliesShape(z: ZodNs) {
  return {
    replies: z
      .array(
        z.object({
          ref: z.string().describe("The thread's ref, e.g. 'T1'."),
          status: z
            .enum(['reply_accepted', 'reply_disputed', 'not_checked'])
            .describe(
              "reply_accepted: the reply is reasonable. reply_disputed: it does not hold up. not_checked: you could not judge it.",
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
        }),
      )
      .describe('One entry per thread in the message, each ref once.'),
  };
}
