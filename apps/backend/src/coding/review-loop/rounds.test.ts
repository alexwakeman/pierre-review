// THE SHARED ROUND RULE (coding/review-loop/rounds.ts), on STRUCTURAL rows (no Build table):
//   • the stop rule: nothing open ⇒ 'open'; open and k ≤ N ⇒ 'fix'; the closing review (k = N + 1) ⇒ 'open'
//     whatever is open; follow-ups never add to the total (they are the findings they re-raise);
//   • roundOpen counts the round's consolidated non-praise findings, the carried 'not_checked' ones, the
//     open follow-ups of the lead run only, and the open criteria minus accepted "not applicable" notes;
//   • THE cannot_meet STOP: no open finding, and every open criterion one the agent said (last round, with a
//     reason) it cannot meet ⇒ 'open' before N.
import { describe, expect, it } from 'vitest';
import type { ClaudeReviewFollowUpRecord, TicketAssessment } from '@pierre-review/shared';
import { cannotMeetOf, nextAfterReview, onlyCannotMeetLeft, roundOpen, type LoopCheckLike, type LoopFindingLike, type LoopRunLike } from './rounds.js';

const followUp = (items: Array<{ priorFindingId: number; status: string }>): ClaudeReviewFollowUpRecord =>
  ({ priorReviewId: 1, priorHeadSha: 'a', headMoved: true, changesSinceShown: false, items }) as unknown as ClaudeReviewFollowUpRecord;

const run = (id: number, round: number, o: Partial<LoopRunLike> = {}): LoopRunLike => ({
  id,
  round,
  targetKind: 'pr',
  targetId: 7,
  status: 'succeeded',
  pairRole: null,
  followUp: null,
  headSha: `h${round}`,
  provider: 'claude',
  ...o,
});
const finding = (id: number, reviewId: number, o: Partial<LoopFindingLike> = {}): LoopFindingLike => ({ id, reviewId, severity: 'warning', mergedInto: null, ...o });
const assessment = (criteria: Array<{ ref: string; status: string }>, missing: Array<{ ref: string }> = []): TicketAssessment =>
  ({
    criteria: criteria.map((c) => ({ ...c, text: c.ref, explanation: null })),
    missing: missing.map((m) => ({ ...m, title: m.ref, explanation: null })),
  }) as unknown as TicketAssessment;

describe('nextAfterReview (the stop rule)', () => {
  it('ends the loop when nothing is open', () => {
    expect(nextAfterReview({ findings: 0, criteria: 0 }, 1, 5)).toBe('open');
  });
  it('fixes while something is open and a fix pass is left', () => {
    expect(nextAfterReview({ findings: 2, criteria: 0 }, 1, 5)).toBe('fix');
    expect(nextAfterReview({ findings: 0, criteria: 1 }, 5, 5)).toBe('fix');
  });
  it('ends at the closing review (round N + 1) whatever is open', () => {
    expect(nextAfterReview({ findings: 3, criteria: 2 }, 6, 5)).toBe('open');
    expect(nextAfterReview({ findings: 1, criteria: 0 }, 2, 1)).toBe('open');
  });
});

describe('roundOpen', () => {
  it('counts findings, carried not_checked ones, lead follow-ups and open criteria', () => {
    const reviews: LoopRunLike[] = [
      run(1, 1),
      run(2, 2, { pairRole: 'first', followUp: followUp([{ priorFindingId: 10, status: 'not_addressed' }, { priorFindingId: 11, status: 'not_checked' }]) }),
      run(3, 2, { pairRole: 'second', followUp: followUp([{ priorFindingId: 10, status: 'reply_disputed' }]) }),
    ];
    const findings: LoopFindingLike[] = [
      finding(10, 1),
      finding(11, 1),
      finding(20, 2),
      finding(21, 3, { mergedInto: 20 }),
      finding(22, 3, { severity: 'praise' }),
      finding(23, 3),
    ];
    const check: LoopCheckLike = {
      round: 2,
      status: 'succeeded',
      assessment: assessment([{ ref: 'AC1', status: 'met' }, { ref: 'AC2', status: 'not_met' }, { ref: 'AC3', status: 'unclear' }], [{ ref: 'M1' }]),
      claimVerdicts: [{ ref: 'AC3', verdict: 'accepted', why: 'n/a' }],
    };
    expect(roundOpen(2, reviews, findings, check, [check])).toEqual({ findings: 3, followUps: 1, criteria: 2 });
  });

  it('reads no criteria from a check that did not succeed', () => {
    const check: LoopCheckLike = { round: 1, status: 'failed', assessment: assessment([{ ref: 'AC1', status: 'not_met' }]), claimVerdicts: null };
    expect(roundOpen(1, [run(1, 1)], [], check).criteria).toBe(0);
  });
});

describe('the cannot_meet stop', () => {
  const answers = [
    { round: 1, ref: 'AC2', response: 'cannot_meet', text: 'Another service sends it.' },
    { round: 1, ref: 'ac3', response: 'cannot_meet', text: '  ' },
    { round: 1, ref: 'M1', response: 'fixed', text: 'Done.' },
    { round: 2, ref: 'AC4', response: 'cannot_meet', text: 'Later.' },
  ];

  it('reads the reasons of ONE round (a blank reason is no answer)', () => {
    expect([...cannotMeetOf(answers, 1).entries()]).toEqual([['AC2', 'Another service sends it.']]);
    expect([...cannotMeetOf(answers, 2).keys()]).toEqual(['AC4']);
  });

  it('stops only when every open item is such a criterion', () => {
    const cm = cannotMeetOf(answers, 1);
    expect(onlyCannotMeetLeft({ findings: 0 }, [{ ref: 'AC2' }], cm)).toBe(true);
    expect(onlyCannotMeetLeft({ findings: 1 }, [{ ref: 'AC2' }], cm)).toBe(false);
    expect(onlyCannotMeetLeft({ findings: 0 }, [{ ref: 'AC2' }, { ref: 'AC3' }], cm)).toBe(false);
    expect(onlyCannotMeetLeft({ findings: 0 }, [], cm)).toBe(false);
    expect(nextAfterReview({ findings: 0, criteria: 1 }, 2, 5)).toBe('fix');
    expect(nextAfterReview({ findings: 0, criteria: 1 }, 2, 5, { onlyCannotMeet: true })).toBe('open');
  });
});

// 6. CODE OUTSIDE THE TICKET in the loop's stop rule (owner decision 2026-11-19): met ONLY by an UNLINKED
//    same-branch PR stays OPEN ('met_unlinked'); met by another repository's DEFAULT BRANCH is done.
describe('openCriteriaOf — code outside the ticket', () => {
  it('keeps an unlinked-only met open and a default-branch met done', async () => {
    const { openCriteriaOf } = await import('./rounds.js');
    const crit = (ref: string, outside: 'repo' | 'unlinked_pr' | null) => ({
      ref,
      index: 0,
      text: ref,
      status: 'met' as const,
      explanation: null,
      deliveredBy: [],
      evidence: [],
      expectedIn: null,
      ...(outside ? { outside: { kind: outside, repoId: 1, repo: 'acme/x', prId: outside === 'unlinked_pr' ? 8 : null, number: outside === 'unlinked_pr' ? 8 : null } } : {}),
    });
    const check: LoopCheckLike = {
      round: 1,
      status: 'succeeded',
      claimVerdicts: null,
      assessment: { alignment: 'partly_aligned', summary: null, criteria: [crit('AC1', 'repo'), crit('AC2', 'unlinked_pr'), crit('AC3', null)], missing: [], notRequested: [] },
    };
    expect(openCriteriaOf(check).map((c) => [c.ref, c.status])).toEqual([['AC2', 'met_unlinked']]);
  });
});
