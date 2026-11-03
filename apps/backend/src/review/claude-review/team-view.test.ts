// THE MERGED REVIEW (team-view.ts `foldTeamReview`, pure). Pins:
//   1. A teammate-only open finding joins the one list, naming the teammate.
//   2. A finding whose GitHub thread is resolved drops out.
//   3. A later own review judging it addressed drops it (a later "not addressed" brings it back).
//   4. The same point raised by the reader and a teammate shows once, naming both (chain or spot).
//   5. The newest review leads: a teammate review posted after the reader's leads; a run in progress
//      or a newer own run leads.
//   6. The review count (`teamReviewCount`): a pair once, each teammate review under its poster.
//   7. A threadless finding (PR-level) drops out once the reader's newer review at another head no
//      longer raises it; two PR-level points match on the title alone.
//   8. The reader's follow-up settling its own finding settles a teammate's spot-matched twin.
//   9. A failed or skipped own run never outranks a teammate review for the lead.
//  10. THE LEAD RULE (`teamReviewLead`), the one copy the Open PRs column / Pending also read.
import { describe, expect, it } from 'vitest';
import type { ClaudeTeammateFinding, ClaudeTeammateReview } from '@pierre-review/shared';
import { foldTeamReview, teamReviewCount, teamReviewLead, type TeamFoldInput } from './team-view.js';

const ROBIN = { userId: 7, login: 'robin-dev', displayName: 'Robin Dunn', avatarUrl: null };
const SAM = { userId: 8, login: 'sam-dev', displayName: 'Sam Lee', avatarUrl: null };

function tf(id: number, over: Partial<ClaudeTeammateFinding> = {}): ClaudeTeammateFinding {
  return {
    id,
    path: 'src/x.ts',
    line: 10,
    severity: 'warning',
    title: `Point ${id}`,
    body: 'Body',
    kind: 'inline',
    githubUrl: null,
    threadId: 100 + id,
    ...over,
  };
}

function tr(reviewId: number, postedAt: string, findings: ClaudeTeammateFinding[], poster = ROBIN): ClaudeTeammateReview {
  return {
    reviewId,
    poster,
    headSha: 'a'.repeat(40),
    headInferred: false,
    postedAt,
    githubUrl: null,
    summary: 'Their summary',
    verdict: 'COMMENT',
    run: 'auto',
    pair: false,
    runs: [],
    limnVersion: null,
    findings,
  };
}

const T1 = '2026-11-01T10:00:00Z';
const T2 = '2026-11-02T10:00:00Z';

function input(over: Partial<TeamFoldInput> = {}): TeamFoldInput {
  return {
    teammateReviews: [],
    own: null,
    ownChain: new Map(),
    judgements: [],
    resolvedThreads: new Set(),
    threadJudgements: null,
    ...over,
  };
}

const ownAt = (iso: string, findings: NonNullable<TeamFoldInput['own']>['findings'] = [], status: 'succeeded' | 'running' = 'succeeded') => ({
  status,
  at: new Date(iso).getTime(),
  findings,
});

describe('foldTeamReview', () => {
  it('a teammate-only open finding joins the list, naming the teammate', () => {
    const v = foldTeamReview(input({ teammateReviews: [tr(50, T2, [tf(1)])], own: ownAt(T1) }));
    expect(v.findings.map((f) => f.id)).toEqual([1]);
    expect(v.findings[0]!.by.map((p) => p.login)).toEqual(['robin-dev']);
    expect(v.findings[0]!.reviewId).toBe(50);
  });

  it('a resolved teammate finding drops out', () => {
    const v = foldTeamReview(
      input({ teammateReviews: [tr(50, T1, [tf(1), tf(2, { title: 'Other thing', line: 40 })])], resolvedThreads: new Set([101]) }),
    );
    expect(v.findings.map((f) => f.id)).toEqual([2]);
  });

  it('a later own review judging it addressed drops it; the newest judgement wins', () => {
    const base = { teammateReviews: [tr(50, T1, [tf(1)])], own: ownAt(T2) };
    const addressed = foldTeamReview(
      input({ ...base, judgements: [{ reviewId: 60, items: [{ priorFindingId: 1, status: 'addressed' }] }] }),
    );
    expect(addressed.findings).toEqual([]);
    // Judged through the reader's own re-raise of it (chain 70 → 1).
    const viaChain = foldTeamReview(
      input({
        ...base,
        ownChain: new Map([[70, 1]]),
        judgements: [{ reviewId: 61, items: [{ priorFindingId: 70, status: 'no_longer_applies' }] }],
      }),
    );
    expect(viaChain.findings).toEqual([]);
    const reopened = foldTeamReview(
      input({
        ...base,
        judgements: [
          { reviewId: 62, items: [{ priorFindingId: 1, status: 'not_addressed' }] },
          { reviewId: 60, items: [{ priorFindingId: 1, status: 'addressed' }] },
        ],
      }),
    );
    expect(reopened.findings.map((f) => f.id)).toEqual([1]);
    // No follow-up judgement: the reader's thread judgement decides.
    const byThread = foldTeamReview(input({ ...base, threadJudgements: [{ threadId: 101, addressed: 'addressed' }] }));
    expect(byThread.findings).toEqual([]);
  });

  it('the same point raised by the reader and a teammate shows once, naming both', () => {
    // By the follow-up chain: the reader's finding 70 re-raises teammate finding 1.
    const linked = foldTeamReview(
      input({
        teammateReviews: [tr(50, T1, [tf(1)])],
        own: ownAt(T2, [{ id: 70, path: 'src/x.ts', line: 90, title: 'Reworded', severity: 'warning', priorFindingId: 1 }]),
      }),
    );
    expect(linked.findings).toEqual([]);
    expect(linked.alsoRaisedBy).toEqual([{ findingId: 70, by: [ROBIN] }]);
    // By spot: same path, nearby line, similar title.
    const spot = foldTeamReview(
      input({
        teammateReviews: [tr(50, T1, [tf(1, { title: 'Null check missing on parser input' })])],
        own: ownAt(T2, [
          { id: 71, path: 'src/x.ts', line: 12, title: 'Missing null check on parser input', severity: 'blocker', priorFindingId: null },
        ]),
      }),
    );
    expect(spot.findings).toEqual([]);
    expect(spot.alsoRaisedBy).toEqual([{ findingId: 71, by: [ROBIN] }]);
    // Far apart lines are not the same spot.
    const far = foldTeamReview(
      input({
        teammateReviews: [tr(50, T1, [tf(1, { title: 'Null check missing on parser input' })])],
        own: ownAt(T2, [
          { id: 72, path: 'src/x.ts', line: 80, title: 'Missing null check on parser input', severity: 'blocker', priorFindingId: null },
        ]),
      }),
    );
    expect(far.findings.map((f) => f.id)).toEqual([1]);
    // Two teammates on the same point: one entry, both named, first poster first.
    const two = foldTeamReview(
      input({
        teammateReviews: [
          tr(51, T2, [tf(2, { title: 'Null check missing', threadId: 300 })], SAM),
          tr(50, T1, [tf(1, { title: 'Null check missing' })]),
        ],
      }),
    );
    expect(two.findings).toHaveLength(1);
    expect(two.findings[0]!.by.map((p) => p.login)).toEqual(['robin-dev', 'sam-dev']);
  });

  it('the newest review leads', () => {
    const tm = [tr(50, T2, [tf(1)])];
    expect(foldTeamReview(input({ teammateReviews: tm, own: ownAt(T1) }))).toMatchObject({ lead: 'teammate', teammateReviewId: 50 });
    expect(foldTeamReview(input({ teammateReviews: tm, own: null }))).toMatchObject({ lead: 'teammate', teammateReviewId: 50 });
    expect(foldTeamReview(input({ teammateReviews: tm, own: ownAt('2026-11-03T10:00:00Z') }))).toMatchObject({
      lead: 'own',
      teammateReviewId: null,
    });
    // A run of the reader's in progress is the newest work.
    expect(foldTeamReview(input({ teammateReviews: tm, own: ownAt(T1, [], 'running') }))).toMatchObject({ lead: 'own' });
    expect(foldTeamReview(input({ own: ownAt(T1) }))).toMatchObject({ lead: 'own', findings: [] });
    expect(foldTeamReview(input())).toMatchObject({ lead: null });
  });
});

describe('foldTeamReview: review fixes', () => {
  const T3 = '2026-11-03T10:00:00Z';
  const prLevel = tf(1, { path: '', line: null, kind: 'pr_comment', threadId: null, title: 'Release notes are missing' });

  it('a threadless teammate finding drops out once a newer own review at another head no longer raises it', () => {
    const tm = [tr(50, T1, [prLevel])];
    const newerHead = { ...ownAt(T2), headSha: 'b'.repeat(40), reviewMode: 'worktree' as const };
    expect(foldTeamReview(input({ teammateReviews: tm, own: newerHead })).findings).toEqual([]);
    // Same head: the reader's Limn only disagreed; the point stands.
    expect(foldTeamReview(input({ teammateReviews: tm, own: { ...newerHead, headSha: 'a'.repeat(40) } })).findings.map((f) => f.id)).toEqual([1]);
    // An older own review supersedes nothing.
    expect(foldTeamReview(input({ teammateReviews: [tr(50, T3, [prLevel])], own: newerHead })).findings.map((f) => f.id)).toEqual([1]);
    // A skip reviewed nothing.
    expect(foldTeamReview(input({ teammateReviews: tm, own: { ...newerHead, reviewMode: 'skip' } })).findings.map((f) => f.id)).toEqual([1]);
    // A threaded finding keeps its thread routes only.
    expect(
      foldTeamReview(input({ teammateReviews: [tr(50, T1, [tf(2)])], own: newerHead })).findings.map((f) => f.id),
    ).toEqual([2]);
  });

  it('two PR-level points with similar titles show once, naming the teammate', () => {
    const v = foldTeamReview(
      input({
        teammateReviews: [tr(50, T1, [prLevel])],
        own: {
          ...ownAt(T2, [{ id: 70, path: '', line: null, title: 'Missing release notes', severity: 'warning', priorFindingId: null }]),
          headSha: 'b'.repeat(40),
        },
      }),
    );
    expect(v.findings).toEqual([]);
    expect(v.alsoRaisedBy).toEqual([{ findingId: 70, by: [ROBIN] }]);
  });

  it("the reader's follow-up settling its own finding settles a teammate's spot-matched twin", () => {
    // R1 (id 60) raised F1 (id 70) at a.ts:11; Robin then posted T1 at a.ts:10. R2 judges F1 addressed.
    const robin = tr(50, T2, [tf(1, { path: 'a.ts', line: 10, title: 'Null check missing on parser input' })]);
    const ownSpots = new Map([[70, { path: 'a.ts', line: 11, title: 'Missing null check on parser input' }]]);
    const judgedAt = new Date(T3).getTime();
    const base = { teammateReviews: [robin], own: ownAt(T3), ownChain: new Map([[70, null]]), ownSpots };
    const settled = foldTeamReview(
      input({ ...base, judgements: [{ reviewId: 61, at: judgedAt, items: [{ priorFindingId: 70, status: 'addressed' }] }] }),
    );
    expect(settled.findings).toEqual([]);
    // Partly addressed keeps the twin open.
    const partly = foldTeamReview(
      input({ ...base, judgements: [{ reviewId: 61, at: judgedAt, items: [{ priorFindingId: 70, status: 'partly_addressed' }] }] }),
    );
    expect(partly.findings.map((f) => f.id)).toEqual([1]);
    // A teammate post AFTER the judging review is a new raise: not settled.
    const later = foldTeamReview(
      input({
        ...base,
        teammateReviews: [tr(50, '2026-11-04T10:00:00Z', robin.findings)],
        judgements: [{ reviewId: 61, at: judgedAt, items: [{ priorFindingId: 70, status: 'addressed' }] }],
      }),
    );
    expect(later.findings.map((f) => f.id)).toEqual([1]);
  });

  it('a failed or skipped own run never outranks a teammate review for the lead', () => {
    const tm = [tr(50, T1, [tf(1)])];
    expect(foldTeamReview(input({ teammateReviews: tm, own: { ...ownAt(T2), status: 'failed' } }))).toMatchObject({
      lead: 'teammate',
      teammateReviewId: 50,
    });
    expect(foldTeamReview(input({ teammateReviews: tm, own: { ...ownAt(T2), reviewMode: 'skip' } }))).toMatchObject({
      lead: 'teammate',
      teammateReviewId: 50,
    });
    // Alone, a failed run still heads the tab (it says it failed).
    expect(foldTeamReview(input({ own: { ...ownAt(T2), status: 'failed' } }))).toMatchObject({ lead: 'own' });
  });
});

describe('teamReviewCount', () => {
  it('counts a pair once and each teammate review under its poster, most first', () => {
    const own = [
      { id: 1, pairId: null },
      { id: 2, pairId: 2 },
      { id: 3, pairId: 2 },
    ];
    const c = teamReviewCount(own, [tr(10, T1, []), tr(11, T2, [], SAM), tr(12, T2, [], SAM)]);
    expect(c.total).toBe(5);
    expect(c.byTeammate).toEqual([
      { poster: SAM, count: 2 },
      { poster: ROBIN, count: 1 },
    ]);
  });
  it('is zero with nothing run', () => {
    expect(teamReviewCount([], [])).toEqual({ total: 0, byTeammate: [] });
  });
});

describe('teamReviewLead (the one lead rule)', () => {
  const t1 = new Date(T1).getTime();
  const t2 = new Date(T2).getTime();
  const own = (status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled', at: number, reviewMode?: 'skip') => ({
    status,
    at,
    ...(reviewMode ? { reviewMode } : {}),
  });
  it('a teammate review newer than the reader\'s succeeded run leads', () => {
    expect(teamReviewLead(own('succeeded', t1), t2)).toBe('teammate');
  });
  it('the reader\'s newer succeeded run leads (a tie keeps the reader\'s)', () => {
    expect(teamReviewLead(own('succeeded', t2), t1)).toBe('own');
    expect(teamReviewLead(own('succeeded', t1), t1)).toBe('own');
  });
  it('a queued or running own run leads, however old the teammate review', () => {
    expect(teamReviewLead(own('running', t1), t2)).toBe('own');
    expect(teamReviewLead(own('queued', t1), t2)).toBe('own');
  });
  it('a failed, cancelled or skipped own run never leads over a teammate review', () => {
    expect(teamReviewLead(own('failed', t2), t1)).toBe('teammate');
    expect(teamReviewLead(own('cancelled', t2), t1)).toBe('teammate');
    expect(teamReviewLead(own('succeeded', t2, 'skip'), t1)).toBe('teammate');
  });
  it('a teammate-only PR is led by the teammate; nothing at all is null', () => {
    expect(teamReviewLead(null, t1)).toBe('teammate');
    expect(teamReviewLead(own('failed', t1), null)).toBe('own');
    expect(teamReviewLead(null, null)).toBeNull();
  });
});
