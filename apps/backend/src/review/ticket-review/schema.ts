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

/**
 * The fields of one CONTRIBUTION CARD (cards.ts) — what one PR's head does, never a verdict. Shared
 * by the ticket review's `cards` and the pre-pass's `submit_pr_card`. The server re-checks every
 * field (`normaliseCard`).
 */
export function buildCardFields(z: ZodNs) {
  return {
    summary: z
      .string()
      .describe('What this pull request does: its features and behaviour, in two to five plain sentences. Facts only, no verdict.'),
    interfaces: z
      .array(
        z.object({
          kind: z.enum(['endpoint', 'field', 'event', 'config', 'export', 'schema', 'other']),
          name: z.string().describe('The exact name: a route ("POST /api/x"), a field ("Order.total"), an event, a setting, an exported symbol, a table or column.'),
          change: z.enum(['added', 'changed', 'removed']),
          note: z.string().nullable().optional().describe('One short line: its shape or meaning, when it matters to a caller.'),
        }),
      )
      .describe('Every contract point another pull request might depend on or provide. The most important part: be exact.'),
    criteria: z
      .array(
        z.object({
          criterion: z.string().describe("The story criterion's text (short), or its ref."),
          how: z.string().describe('How this pull request moves it forward, in one sentence.'),
          files: z.array(z.string()).optional(),
        }),
      )
      .optional()
      .describe('The story criteria this pull request moves forward, if any. Do not judge whether they are met.'),
    looseEnds: z
      .array(z.string())
      .optional()
      .describe("TODOs, stubs, placeholders, code behind a flag that is off — judged against this pull request's OWN aim, not the whole story."),
  };
}

export function buildSubmitPrCardShape(z: ZodNs) {
  return buildCardFields(z);
}
export type SubmitPrCardShape = ReturnType<typeof buildSubmitPrCardShape>;

/** The pre-pass tool's raw shape, built from the runtime's zod. */
export async function submitPrCardShape(): Promise<SubmitPrCardShape> {
  return buildSubmitPrCardShape(await loadZod());
}

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
    cards: z
      .array(z.object({ pr: memberRef, ...buildCardFields(z) }))
      .optional()
      .describe("One contribution card for EVERY pull request shown to you as a DIFF (never one shown as a description): what its head does, for later checks of this ticket."),
  };
}

export type SubmitTicketReviewShape = ReturnType<typeof buildSubmitTicketReviewShape>;
export type SubmitTicketReviewPayload = Zod.infer<Zod.ZodObject<SubmitTicketReviewShape>>;

/** The raw shape `tool()` wants, built from the runtime's zod. */
export async function submitTicketReviewShape(): Promise<SubmitTicketReviewShape> {
  return buildSubmitTicketReviewShape(await loadZod());
}
