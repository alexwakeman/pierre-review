// THE GAP FOLD (coverage.ts). Pinned:
//   1. no check ⇒ every criterion a gap ('none'), AC refs from the story's own numbering;
//   2. a stored check ⇒ its verdicts: met is done (with the PRs that deliver it), everything else and every
//      missing item a gap.
import { describe, expect, it } from 'vitest';
import { storyBuildIsGap, type StoryBuildCoverage, type TicketAssessment } from '@pierre-review/shared';
import { foldCoverage } from './coverage.js';
import type { StoryBuildTicketPr } from './inputs.js';

const CRITERIA = [
  { n: 1, text: 'Refund by card' },
  { n: 2, text: 'Email a receipt' },
];
const PR: StoryBuildTicketPr = { prId: 5, repoId: 1, number: 12, title: 'ACME-1 refunds', headSha: 'abc', state: 'open', headRefName: 'f', byReader: true };
const ASSESSMENT: TicketAssessment = {
  alignment: 'partly_aligned',
  summary: 's',
  criteria: [
    { ref: 'AC1', index: 0, text: 'AC1: Refund by card', status: 'met', explanation: null, deliveredBy: [5, 5], evidence: [], expectedIn: null },
    { ref: 'AC2', index: 1, text: 'Email a receipt', status: 'partly_met', explanation: null, deliveredBy: [5], evidence: [], expectedIn: null },
  ],
  missing: [{ ref: 'M1', title: 'An audit log line', explanation: null, expectedIn: null }],
  notRequested: [],
};
const LATEST = { id: 9, assessment: ASSESSMENT, completedAt: new Date('2026-10-01T00:00:00Z') };
const gapRefs = (c: StoryBuildCoverage): string[] => [...c.criteria.filter(storyBuildIsGap).map((x) => x.ref), ...c.missing.map((m) => m.ref)];

describe('foldCoverage', () => {
  it('no ticket PR: every criterion is a gap', () => {
    const c = foldCoverage({ criteria: CRITERIA, check: null, state: 'none', prs: [], note: null });
    expect(c.criteria).toEqual([
      { ref: 'AC1', text: 'Refund by card', verdict: 'not_checked', coveredByPrIds: [] },
      { ref: 'AC2', text: 'Email a receipt', verdict: 'not_checked', coveredByPrIds: [] },
    ]);
    expect(gapRefs(c)).toEqual(['AC1', 'AC2']);
  });

  it("a check's verdicts: met is done, the rest and every missing item are gaps", () => {
    const c = foldCoverage({ criteria: CRITERIA, check: LATEST, state: 'checked', prs: [PR], note: null });
    expect(c).toMatchObject({ state: 'checked', ticketReviewId: 9, checkedAt: '2026-10-01T00:00:00.000Z' });
    expect(c.criteria[0]).toEqual({ ref: 'AC1', text: 'Refund by card', verdict: 'met', coveredByPrIds: [5] });
    expect(c.criteria[1]!.coveredByPrIds).toEqual([]);
    expect(c.existingPrs).toEqual([{ prId: 5, repoId: 1, number: 12, state: 'open', headSha: 'abc' }]);
    expect(gapRefs(c)).toEqual(['AC2', 'M1']);
  });
});
