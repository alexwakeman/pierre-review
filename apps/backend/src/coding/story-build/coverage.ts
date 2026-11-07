import { criterionTextOnly, type StoryBuildCoverage, type StoryDocsCriterion, type TicketAssessment } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { StoryBuildTicketPr } from './inputs.js';

// THE GAP FOLD ("Implement story", docs/STORY-BUILD.md § Fill gaps): what the ticket's EXISTING pull
// requests already deliver, from the latest stored story check. A workspace session NEVER starts a check:
// Fill gaps is offered only on a CURRENT check (shared `storyBuildOffered`), and the session reads it at
// boot (`latestTicketCheck`) for TICKET.md's verdicts.
//
//   no check                every criterion is a gap                                  state 'none'
//   a stored check          its verdicts: `met` is done (with the PRs that deliver it), anything else
//                           — partly_met / not_met / unclear / not_checked — is a gap, and every
//                           `missing` item (M1…) is a gap too                         state 'checked'
//
// The fold itself (`foldCoverage`) is PURE.

export interface CoverageCheck {
  id: number;
  assessment: TicketAssessment | null;
  completedAt: Date | null;
}

/** The fold (pure). `criteria` is the story's own list (inputs), used when no check is folded. */
export function foldCoverage(a: {
  criteria: readonly StoryDocsCriterion[];
  check: CoverageCheck | null;
  state: StoryBuildCoverage['state'];
  prs: readonly StoryBuildTicketPr[];
  note: string | null;
}): StoryBuildCoverage {
  const existingPrs = a.prs.map((p) => ({ prId: p.prId, repoId: p.repoId, number: p.number, state: p.state, headSha: p.headSha || null }));
  const assessment = a.state === 'checked' || a.state === 'stale' ? (a.check?.assessment ?? null) : null;
  if (assessment != null) {
    return {
      state: a.state,
      ticketReviewId: a.check!.id,
      checkedAt: a.check!.completedAt ? a.check!.completedAt.toISOString() : null,
      criteria: assessment.criteria.map((c) => ({
        ref: c.ref,
        text: criterionTextOnly(c.text, c.ref),
        verdict: c.status,
        coveredByPrIds: c.status === 'met' ? [...new Set(c.deliveredBy)] : [],
      })),
      missing: assessment.missing.map((m) => ({ ref: m.ref, text: m.title })),
      existingPrs,
      note: a.note,
    };
  }
  return {
    state: a.state === 'checked' || a.state === 'stale' ? 'none' : a.state,
    ticketReviewId: null,
    checkedAt: null,
    criteria: a.criteria.map((c) => ({ ref: `AC${c.n}`, text: c.text, verdict: 'not_checked', coveredByPrIds: [] })),
    missing: [],
    existingPrs,
    note: a.note,
  };
}

/** The ticket's latest SUCCEEDED story check, or null (DB only). */
export async function latestTicketCheck(ctx: AgentContext, accountId: number, ident: string): Promise<CoverageCheck | null> {
  const { getTicketStateInputs } = await import('../../review/ticket-review/persist.js');
  const latest = (await getTicketStateInputs(ctx, accountId, [ident])).get(ident)?.latest ?? null;
  return latest == null ? null : { id: latest.id, assessment: latest.assessment, completedAt: latest.completedAt };
}
