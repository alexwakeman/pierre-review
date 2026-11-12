// THE REVIEW LOOP'S PURE FOLDS (loop/wire.ts) that carry state ACROSS rounds:
//   • an ACCEPTED "not applicable" stays settled on later rounds (no claim is sent again for it);
//   • a finding a round's review left 'not_checked' stays open: counted, carried into the next round's
//     follow-up input (`carried: true`), and in the PR body's "still open".
import { describe, expect, it } from 'vitest';
import type { TicketAssessment } from '@pierre-review/shared';
import type { LoopFindingRow, LoopReviewRow, LoopStoryCheckRow } from './persist.js';
import { acceptedNa, effectiveClaimVerdicts, loopBodySummaryOf, notCheckedIdsOf, openCriteriaOf, priorForTarget, roundOpen } from './wire.js';

const crit = (ref: string, status: string): TicketAssessment['criteria'][number] =>
  ({ ref, index: 0, text: ref, status, explanation: null, deliveredBy: [], evidence: [], expectedIn: null }) as unknown as TicketAssessment['criteria'][number];

const check = (round: number, criteria: TicketAssessment['criteria'], verdicts: LoopStoryCheckRow['claimVerdicts']): LoopStoryCheckRow =>
  ({
    id: round,
    round,
    status: 'succeeded',
    assessment: { alignment: 'partly_aligned', summary: 's', criteria, missing: [], notRequested: [] } as unknown as TicketAssessment,
    claimVerdicts: verdicts,
  }) as unknown as LoopStoryCheckRow;

const review = (id: number, round: number, items: Array<{ priorFindingId: number; status: string }> = []): LoopReviewRow =>
  ({
    id,
    round,
    targetKind: 'repo',
    targetId: 1,
    repoId: 1,
    headSha: `h${round}`,
    baseSha: 'b',
    provider: 'claude',
    pairRole: null,
    status: 'succeeded',
    followUp: { items: items.map((it) => ({ ...it, explanation: null, response: null })) },
    createdAt: new Date(0),
  }) as unknown as LoopReviewRow;

const finding = (id: number, reviewId: number, round: number, over: Partial<LoopFindingRow> = {}): LoopFindingRow =>
  ({
    id,
    reviewId,
    round,
    severity: 'blocker',
    path: 'a.ts',
    line: 1,
    side: 'RIGHT',
    title: `F${id}`,
    body: 'b',
    suggestion: null,
    diffHunk: null,
    anchored: true,
    fileInDiff: true,
    priorFindingId: null,
    lens: null,
    mergedInto: null,
    ref: null,
    response: null,
    responseText: null,
    responseRound: null,
    createdAt: new Date(0),
    ...over,
  }) as LoopFindingRow;

describe('accepted "not applicable" carries forward', () => {
  const c1 = check(1, [crit('AC1', 'met'), crit('AC2', 'not_met')], []);
  const c2 = check(2, [crit('AC1', 'met'), crit('AC2', 'not_met')], [{ ref: 'AC2', verdict: 'accepted', why: 'Another team.' }]);
  // Round 3 got no claim for AC2 (it left the seed) and judges it not_met again.
  const c3 = check(3, [crit('AC1', 'met'), crit('AC2', 'not_met')], []);
  const all = [c1, c2, c3];

  it('stays settled on the next round, and the wire / body list it', () => {
    expect(openCriteriaOf(c2, all)).toEqual([]);
    expect(openCriteriaOf(c3, all)).toEqual([]);
    expect([...acceptedNa(c3, all)]).toEqual(['AC2']);
    expect(effectiveClaimVerdicts(c3, all)).toEqual([{ ref: 'AC2', verdict: 'accepted', why: 'Another team.' }]);
    expect(roundOpen(3, [], [], c3, all).criteria).toBe(0);
    const body = loopBodySummaryOf({ reviews: [], findings: [], checks: all, acResponses: [], finalRound: 3, providers: ['claude'] }, null);
    expect(body.criteria).toEqual({ met: 1, notApplicable: [{ ref: 'AC2', why: 'Another team.' }], notMet: 0 });
  });

  it('a later rejection wins; an earlier rejection is not carried', () => {
    const c4 = check(4, [crit('AC2', 'not_met')], [{ ref: 'AC2', verdict: 'rejected', why: 'It does apply.' }]);
    expect(openCriteriaOf(c4, [...all, c4]).map((c) => c.ref)).toEqual(['AC2']);
    const r1 = check(1, [crit('AC2', 'not_met')], [{ ref: 'AC2', verdict: 'rejected', why: 'No.' }]);
    const r2 = check(2, [crit('AC2', 'not_met')], []);
    expect(effectiveClaimVerdicts(r2, [r1, r2])).toEqual([]);
    expect(openCriteriaOf(r2, [r1, r2]).map((c) => c.ref)).toEqual(['AC2']);
  });

  it('without the earlier checks, only this round counts (the old behaviour)', () => {
    expect(openCriteriaOf(c3).map((c) => c.ref)).toEqual(['AC2']);
  });
});

describe("a 'not_checked' finding stays in the chain", () => {
  // Round 1 raised F10 (answered by the agent); round 2's reviewer said nothing about it.
  const reviews = [review(1, 1), review(2, 2, [{ priorFindingId: 10, status: 'not_checked' }])];
  const findings = [finding(10, 1, 1, { response: 'answered', responseText: 'Kept on purpose.', responseRound: 1 })];

  it('counts as open and is carried into the next round', () => {
    expect([...notCheckedIdsOf(reviews, 2)]).toEqual([10]);
    expect(roundOpen(2, reviews, findings, null).findings).toBe(1);
    const prior = priorForTarget(reviews, findings, 'repo', 1, 3, 'claude');
    expect(prior?.findings.map((f) => ({ id: f.id, carried: f.carried }))).toEqual([{ id: 10, carried: true }]);
    expect(prior?.findings[0]?.thread?.replies[0]?.body).toContain('Kept on purpose.');
    const body = loopBodySummaryOf({ reviews, findings, checks: [], acResponses: [], finalRound: 2, providers: ['claude'] }, null);
    expect(body.stillOpen.map((f) => f.title)).toEqual(['F10']);
  });

  it('a finding another run of the round judged is not carried', () => {
    const pair = [...reviews, { ...review(3, 2, [{ priorFindingId: 10, status: 'addressed' }]), provider: 'codex', pairRole: 'second' } as LoopReviewRow];
    expect(notCheckedIdsOf(pair, 2).size).toBe(0);
    expect(roundOpen(2, pair, findings, null).findings).toBe(0);
  });
});
