import type { z as Zod } from 'zod';
import { loadZod } from '../../ai/runtime.js';

// The structured-output contract for the ticket review's in-process `submit_ticket_review` tool.
// Built from a zod namespace handed in (the AI runtime's own install — review/schema.ts explains
// why a second zod instance silently breaks the SDK's tool schemas).
//
// Members are named by their REF from the prompt ('PR1', 'PR2', …), never by an id the model could
// invent; the server maps refs to PR ids and drops any it did not hand out (reconcile.ts).
// 'not_checked' is in NO enum here: only the server writes it.

type ZodNs = typeof Zod;

export function buildSubmitTicketReviewShape(z: ZodNs) {
  const memberRef = z.string().describe("A pull request's ref from the 'Pull requests' section, e.g. 'PR2'.");
  const expectedIn = z
    .object({
      pr: memberRef.nullable().optional(),
      repo: z
        .string()
        .nullable()
        .optional()
        .describe("A repository from the 'Pull requests' section ('owner/name') when no PR there should carry it."),
    })
    .nullable()
    .optional()
    .describe('Where the missing work belongs: the PR that should carry it, else the repository.');
  const where = {
    path: z.string().nullable().optional().describe('A file in that PR, if one shows it.'),
    line: z.number().int().nullable().optional(),
  };

  return {
    alignment: z.enum(['aligned', 'partly_aligned', 'not_aligned', 'unclear']),
    summary: z.string().describe('Markdown: one sentence on how far the pull requests, together, deliver the ticket, then a short "- " bullet per gap (only when there are gaps).'),
    criteria: z
      .array(
        z.object({
          text: z.string().describe('The criterion in one short sentence, as you read it from the acceptance criteria.'),
          status: z.enum(['met', 'partly_met', 'not_met', 'unclear']),
          explanation: z.string(),
          deliveredBy: z
            .array(memberRef)
            .optional()
            .describe('Every PR that delivers this criterion, in whole or in part.'),
          evidence: z
            .array(z.object({ pr: memberRef, ...where }))
            .optional()
            .describe('Where the delivered work is: the PR, the file and the line.'),
          expectedIn,
          ...where,
        }),
      )
      .optional()
      .describe(
        'Every distinct acceptance criterion, in the order it appears, each once. Leave it out when there is no acceptance-criteria text.',
      ),
    missing: z
      .array(
        z.object({
          title: z.string().describe('A short name for what is missing.'),
          explanation: z.string(),
          expectedIn,
          ...where,
        }),
      )
      .optional()
      .describe('What the ticket asks for that no PR does and no criterion covers.'),
    notRequested: z
      .array(
        z.object({
          title: z.string(),
          explanation: z.string(),
          pr: memberRef.nullable().optional(),
          ...where,
        }),
      )
      .optional()
      .describe('What the PRs add that the ticket did not ask for.'),
  };
}

export type SubmitTicketReviewShape = ReturnType<typeof buildSubmitTicketReviewShape>;
export type SubmitTicketReviewPayload = Zod.infer<Zod.ZodObject<SubmitTicketReviewShape>>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitTicketReviewShape(): Promise<SubmitTicketReviewShape> {
  return buildSubmitTicketReviewShape(await loadZod());
}
