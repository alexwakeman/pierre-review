// STANDING VERDICTS, JUDGEMENTS IN THE MARKER, EVERY FINDING, STANDING BLOCKS (docs/CLAUDE-REVIEW.md
// § Teammates' reviews → Standing verdicts / Judgements travel with a post / Every finding). Pure.
import { describe, expect, it } from 'vitest';
import {
  LIMN_META_MAX_JUDGED,
  limnReviewMarker,
  parseLimnReviewMarker,
  type ClaudeTeammateReview,
} from '@pierre-review/shared';
import {
  foldAllTeamFindings,
  githubStandingReview,
  teamDecisions,
  teamStandings,
  withdrawnVerdict,
  type AllFindingsOwn,
  type DecisionReviewInput,
  type StandingGithubReview,
  type StandingsInput,
} from './team-view.js';
import { teammateStillOpenHold } from './replies-pass.js';
import { judgedOutcomeOfFollowUp, judgedOutcomeOfThread } from './post-meta.js';
import { mergeStandingBlocks } from './teammate-anchor.js';

const ME = 1;
const ROBIN = { userId: 2, login: 'robin-dunn', displayName: 'Robin Dunn', avatarUrl: null };
const SAM = { userId: 3, login: 'sam-li', displayName: null, avatarUrl: null };
const t = (iso: string): number => new Date(iso).getTime();

function gh(authorId: number, nodeId: string, state: StandingGithubReview['state'], at: string, over: Partial<StandingGithubReview> = {}): StandingGithubReview {
  return { authorId, nodeId, databaseId: nodeId.replace(/\D/g, ''), state, submittedAt: t(at), limn: true, ...over };
}

// 203001: the reader's Claude + Codex pair asked for changes on 3 Nov (posted, still standing); Robin's
// Limn commented on 4 Nov.
type Input = Omit<StandingsInput, 'teammates' | 'github'> & {
  teammates: Array<StandingsInput['teammates'][number]>;
  github: StandingGithubReview[];
};
function base(): Input {
  return {
    readerUserIds: new Set([ME]),
    ownLatest: { reviewId: 10, verdict: 'REQUEST_CHANGES', at: t('2026-11-03T10:00:00Z'), headSha: 'a'.repeat(40) },
    ownPosted: [{ githubReviewId: '601', reviewId: 10, verdict: 'REQUEST_CHANGES', headSha: 'a'.repeat(40) }],
    teammates: [{ reviewId: 20, poster: ROBIN, verdict: 'COMMENT', at: t('2026-11-04T10:00:00Z'), headSha: 'b'.repeat(40), nodeId: 'RV_602' }],
    github: [gh(ME, 'RV_601', 'changes_requested', '2026-11-03T10:00:00Z'), gh(2, 'RV_602', 'commented', '2026-11-04T10:00:00Z')],
  };
}

describe('teamStandings', () => {
  it("PR 221269: a teammate's replies-pass Approve (no imported row) is in force, with the marker's commit", () => {
    const input = base();
    input.teammates = [{ reviewId: 1377, poster: ROBIN, verdict: 'COMMENT', at: t('2026-11-09T13:04:51Z'), headSha: 'd'.repeat(40), nodeId: 'RV_5826241621' }];
    input.github = [
      gh(ME, 'RV_601', 'changes_requested', '2026-11-03T10:00:00Z'),
      gh(2, 'RV_5826241621', 'commented', '2026-11-09T13:04:51Z'),
      gh(2, 'RV_5826955272', 'approved', '2026-11-09T14:04:21Z', { markerHead: 'd'.repeat(40) }),
    ];
    const robin = teamStandings(input).reviewers.find((r) => !r.you)!;
    expect(robin.latest).toMatchObject({ reviewId: 1377, verdict: 'COMMENT' });
    expect(robin.inForce).toMatchObject({ reviewId: null, verdict: 'APPROVE', at: '2026-11-09T14:04:21.000Z', headSha: 'd'.repeat(40) });
  });

  it("203001: a teammate's later Comment does not lift the reader's Request changes", () => {
    const s = teamStandings(base());
    expect(s.blocking).toMatchObject({ you: true, reviewId: 10, verdict: 'REQUEST_CHANGES' });
    expect(s.latest).toMatchObject({ you: false, poster: { login: 'robin-dunn' }, verdict: 'COMMENT', reviewId: 20 });
    expect(s.reviewers.map((r) => [r.you, r.inForce?.verdict ?? null, r.dismissed])).toEqual([
      [true, 'REQUEST_CHANGES', false],
      [false, null, false],
    ]);
  });

  it('a dismissal on GitHub lifts the verdict', () => {
    const input = base();
    input.github[0] = gh(ME, 'RV_601', 'dismissed', '2026-11-03T10:00:00Z');
    const s = teamStandings(input);
    expect(s.blocking).toBeNull();
    expect(s.reviewers[0]).toMatchObject({ you: true, inForce: null, dismissed: true });
  });

  it("the same reviewer's later decisive review replaces theirs; their later Comment does not", () => {
    const input = base();
    input.teammates = [
      { reviewId: 20, poster: ROBIN, verdict: 'REQUEST_CHANGES', at: t('2026-11-04T10:00:00Z'), headSha: 'b'.repeat(40), nodeId: 'RV_602' },
      { reviewId: 21, poster: ROBIN, verdict: 'COMMENT', at: t('2026-11-05T10:00:00Z'), headSha: 'c'.repeat(40), nodeId: 'RV_603' },
    ];
    input.github = [
      gh(ME, 'RV_601', 'dismissed', '2026-11-03T10:00:00Z'),
      gh(2, 'RV_602', 'changes_requested', '2026-11-04T10:00:00Z'),
      gh(2, 'RV_603', 'commented', '2026-11-05T10:00:00Z'),
    ];
    expect(teamStandings(input).blocking).toMatchObject({ you: false, reviewId: 20 });
    input.teammates.push({ reviewId: 22, poster: ROBIN, verdict: 'APPROVE', at: t('2026-11-06T10:00:00Z'), headSha: 'd'.repeat(40), nodeId: 'RV_604' });
    input.github.push(gh(2, 'RV_604', 'approved', '2026-11-06T10:00:00Z'));
    const s = teamStandings(input);
    expect(s.blocking).toBeNull();
    expect(s.reviewers.find((r) => !r.you)?.inForce).toMatchObject({ verdict: 'APPROVE', reviewId: 22 });
  });

  it("a later decisive review that is not Limn's replaces the Limn verdict", () => {
    const input = base();
    input.github.push(gh(ME, 'RV_700', 'approved', '2026-11-05T10:00:00Z', { limn: false }));
    const s = teamStandings(input);
    expect(s.blocking).toBeNull();
    expect(s.reviewers[0]!.inForce).toBeNull();
  });

  it("the reader's newer unposted run does not lift the posted block", () => {
    const input = base();
    input.ownLatest = { reviewId: 11, verdict: 'APPROVE', at: t('2026-11-05T10:00:00Z'), headSha: 'e'.repeat(40) };
    const s = teamStandings(input);
    expect(s.blocking).toMatchObject({ you: true, reviewId: 10 });
    expect(s.latest).toMatchObject({ you: true, reviewId: 11, verdict: 'APPROVE' });
  });

  it('several blocks: the newest is the one shown; every reviewer is listed, the reader first', () => {
    const input = base();
    input.teammates.push({ reviewId: 30, poster: SAM, verdict: 'REQUEST_CHANGES', at: t('2026-11-04T12:00:00Z'), headSha: 'f'.repeat(40), nodeId: 'RV_610' });
    input.github.push(gh(3, 'RV_610', 'changes_requested', '2026-11-04T12:00:00Z'));
    const s = teamStandings(input);
    expect(s.blocking).toMatchObject({ poster: { login: 'sam-li' }, reviewId: 30 });
    expect(s.reviewers.map((r) => (r.you ? 'you' : r.poster!.login))).toEqual(['you', 'sam-li', 'robin-dunn']);
  });

  it('githubStandingReview skips Comment and Pending; a dismissed latest stands for nothing', () => {
    expect(githubStandingReview([gh(1, 'A1', 'changes_requested', '2026-11-01T00:00:00Z'), gh(1, 'A2', 'commented', '2026-11-02T00:00:00Z')])?.nodeId).toBe('A1');
    expect(githubStandingReview([gh(1, 'A1', 'approved', '2026-11-01T00:00:00Z'), gh(1, 'A2', 'dismissed', '2026-11-02T00:00:00Z')])).toBeNull();
    expect(githubStandingReview([gh(1, 'A1', 'commented', '2026-11-01T00:00:00Z')])).toBeNull();
  });
});

describe('judgements in the summary marker (j=)', () => {
  it('round-trips, bounded, first per comment, malformed entries skipped', () => {
    const judged = [
      { commentId: '611', outcome: 'addressed' as const },
      { commentId: '612', outcome: 'not_addressed' as const },
      { commentId: '613', outcome: 'no_longer_applies' as const },
      { commentId: '611', outcome: 'not_addressed' as const },
      { commentId: 'x9', outcome: 'addressed' as const },
    ];
    const m = limnReviewMarker('n1', { headSha: 'a'.repeat(40), run: 'auto', verdict: 'COMMENT', judged });
    expect(m).toContain('j=611:a,612:n,613:x');
    expect(parseLimnReviewMarker(m)?.judged).toEqual(judged.slice(0, 3));
    const many = Array.from({ length: 80 }, (_, i) => ({ commentId: String(1000 + i), outcome: 'addressed' as const }));
    expect(parseLimnReviewMarker(limnReviewMarker('n2', { judged: many }))?.judged).toHaveLength(LIMN_META_MAX_JUDGED);
    expect(parseLimnReviewMarker('<!-- pierre:claude-review v=1 j=12:a,zz,13:q,14:x -->')?.judged).toEqual([
      { commentId: '12', outcome: 'addressed' },
      { commentId: '14', outcome: 'no_longer_applies' },
    ]);
    // Absent on a post without judgements.
    expect(parseLimnReviewMarker(limnReviewMarker('n3', { run: 'auto' }))?.judged).toBeUndefined();
  });

  it('maps follow-up and thread words to the outcomes (open points are still_open)', () => {
    expect(['addressed', 'reply_accepted', 'no_longer_applies', 'partly_addressed', 'not_addressed', 'reply_disputed', 'not_checked'].map((s) => judgedOutcomeOfFollowUp(s as never))).toEqual([
      'addressed',
      'addressed',
      'no_longer_applies',
      'still_open',
      'still_open',
      'still_open',
      null,
    ]);
    expect(judgedOutcomeOfThread('unclear')).toBeNull();
    // No reading of the comment itself: not addressed, but nothing is held open.
    expect(judgedOutcomeOfThread('partly_addressed')).toBe('not_addressed');
    expect(judgedOutcomeOfThread('not_addressed', 'not_valid')).toBe('not_addressed');
    expect(judgedOutcomeOfThread('not_addressed', 'valid')).toBe('still_open');
    expect(judgedOutcomeOfThread('partly_addressed', 'partly_valid')).toBe('still_open');
    expect(judgedOutcomeOfThread('addressed', 'valid')).toBe('addressed');
  });
});

function own(over: Partial<AllFindingsOwn> & { id: number }): AllFindingsOwn {
  return {
    reviewId: 10,
    at: t('2026-11-03T10:00:00Z'),
    headSha: 'a'.repeat(40),
    path: 'src/a.ts',
    line: 10,
    severity: 'warning',
    title: `Point ${over.id}`,
    body: 'Body.',
    priorFindingId: null,
    providers: ['claude'],
    posted: true,
    ignored: false,
    githubCommentId: String(600 + over.id),
    githubUrl: null,
    threadId: 100 + over.id,
    ...over,
  };
}

function mate(over: Partial<ClaudeTeammateReview> = {}): ClaudeTeammateReview {
  return {
    reviewId: 20,
    poster: ROBIN,
    headSha: 'b'.repeat(40),
    headInferred: false,
    postedAt: '2026-11-04T10:00:00Z',
    githubUrl: null,
    summary: '',
    verdict: 'COMMENT',
    run: 'auto',
    pair: false,
    runs: [],
    limnVersion: null,
    findings: [],
    ...over,
  };
}

describe('foldAllTeamFindings', () => {
  const noJudge = { judgements: [], threadJudgements: null, threadJudgedBy: null } as const;

  it('203001: every point resolved on GitHub, each named by who raised it and which model', () => {
    const ownF = [1, 2, 3, 4].map((id) => own({ id, path: `src/f${id}.ts`, providers: id % 2 ? ['claude'] : ['codex'] }));
    const robin = mate({
      findings: [{ id: 50, path: 'src/r.ts', line: 3, severity: 'nit', title: 'Rename', body: 'b', kind: 'inline', githubUrl: null, threadId: 150, providers: ['claude'] }],
    });
    const all = foldAllTeamFindings({
      own: ownF,
      latestOwnReviewIds: new Set([10]),
      teammateReviews: [robin],
      resolvedThreads: new Set([101, 102, 103, 104, 150]),
      ...noJudge,
    });
    expect(all).toHaveLength(5);
    expect(all.every((p) => p.state.kind === 'resolved_on_github')).toBe(true);
    expect(all.filter((p) => p.author.you).map((p) => p.providers[0])).toEqual(expect.arrayContaining(['claude', 'codex']));
    expect(all.find((p) => p.origin === 'teammate')?.author.poster?.login).toBe('robin-dunn');
  });

  it("a teammate's posted judgement settles the reader's finding; a newer re-raise reopens it", () => {
    const robin = mate({ judged: [{ commentId: '601', outcome: 'addressed' }] });
    const input = {
      own: [own({ id: 1 })],
      latestOwnReviewIds: new Set([10]),
      teammateReviews: [robin],
      resolvedThreads: new Set<number>(),
      ...noJudge,
    };
    expect(foldAllTeamFindings(input)[0]!.state).toEqual({
      kind: 'addressed',
      by: { you: false, poster: ROBIN },
      at: '2026-11-04T10:00:00.000Z',
      reviewId: 20,
    });
    // The reader's later run re-raises it (same chain): open again.
    const again = foldAllTeamFindings({
      ...input,
      own: [own({ id: 1 }), own({ id: 2, reviewId: 11, at: t('2026-11-05T10:00:00Z'), priorFindingId: 1, posted: false, githubCommentId: null, threadId: null })],
      latestOwnReviewIds: new Set([11]),
    });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ findingId: 2, raisedAt: '2026-11-03T10:00:00.000Z', posted: true, state: { kind: 'open' } });
  });

  it("the reader's follow-up judges a teammate's finding; the same point twice shows once", () => {
    const robin = mate({
      findings: [
        { id: 50, path: 'src/a.ts', line: 11, severity: 'warning', title: 'Point 1', body: 'b', kind: 'inline', githubUrl: null, threadId: 150 },
        { id: 51, path: 'src/z.ts', line: 1, severity: 'blocker', title: 'Lock leak', body: 'b', kind: 'inline', githubUrl: null, threadId: 151 },
      ],
    });
    const all = foldAllTeamFindings({
      own: [own({ id: 1 })],
      latestOwnReviewIds: new Set([10]),
      teammateReviews: [robin],
      resolvedThreads: new Set<number>(),
      judgements: [{ reviewId: 12, at: t('2026-11-06T10:00:00Z'), items: [{ priorFindingId: 51, status: 'no_longer_applies' }] }],
      threadJudgements: null,
      threadJudgedBy: null,
    });
    expect(all).toHaveLength(2);
    const mine = all.find((p) => p.findingId === 1)!;
    expect(mine.alsoRaisedBy).toEqual([{ you: false, poster: ROBIN, findingId: 50, reviewId: 20, providers: [] }]);
    expect(all.find((p) => p.findingId === 51)!.state).toMatchObject({ kind: 'no_longer_applies', by: { you: true }, reviewId: 12 });
  });

  it('a re-raise newer than a thread resolved on GitHub keeps the point open (its newest finding acts)', () => {
    const f1 = own({ id: 1 });
    const input = {
      own: [f1],
      latestOwnReviewIds: new Set([10]),
      teammateReviews: [],
      resolvedThreads: new Set([101]),
      ...noJudge,
    };
    expect(foldAllTeamFindings(input)[0]!.state).toEqual({ kind: 'resolved_on_github' });
    // The latest run re-raises it (unposted): open, shown from that finding.
    const again = foldAllTeamFindings({
      ...input,
      own: [f1, own({ id: 2, reviewId: 11, at: t('2026-11-05T10:00:00Z'), priorFindingId: 1, posted: false, githubCommentId: null, threadId: null })],
      latestOwnReviewIds: new Set([11]),
    });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ findingId: 2, reviewId: 11, posted: true, threadId: 101, state: { kind: 'open' } });
    // The re-raise posted, and ITS thread resolved too: resolved again.
    const twice = foldAllTeamFindings({
      ...input,
      own: [f1, own({ id: 2, reviewId: 11, at: t('2026-11-05T10:00:00Z'), priorFindingId: 1 })],
      latestOwnReviewIds: new Set([11]),
      resolvedThreads: new Set([101, 102]),
    });
    expect(twice[0]!.state).toEqual({ kind: 'resolved_on_github' });
  });

  it("an older review's unposted finding was never said: it is left out; the latest's ignored one is flagged", () => {
    const all = foldAllTeamFindings({
      own: [
        own({ id: 1, reviewId: 9, posted: false, githubCommentId: null, threadId: null }),
        own({ id: 2, path: 'src/b.ts', posted: false, ignored: true, githubCommentId: null, threadId: null }),
      ],
      latestOwnReviewIds: new Set([10]),
      teammateReviews: [],
      resolvedThreads: new Set<number>(),
      ...noJudge,
    });
    expect(all.map((p) => [p.findingId, p.ignored])).toEqual([[2, true]]);
  });
});

describe('mergeStandingBlocks', () => {
  const f = (id: number) => ({
    id,
    headSha: 'b'.repeat(40),
    path: 'src/x.ts',
    line: 1,
    side: 'RIGHT' as const,
    severity: 'blocker' as const,
    title: 't',
    body: 'b',
    suggestion: null,
    diffHunk: null,
    anchored: true,
    fileInDiff: true,
    posted: true,
    carried: false,
  });
  const block = { reviewId: 20, headSha: 'b'.repeat(40), teammate: { userId: 2, login: 'robin-dunn' }, findings: [f(50), f(51)] };

  it("adds a standing block's findings to the reader's own previous review as carried", () => {
    const prior = { reviewId: 10, headSha: 'a'.repeat(40), findings: [{ ...f(1), carried: false }] };
    const out = mergeStandingBlocks(prior, [block], new Set([51]));
    expect(out?.reviewId).toBe(10);
    expect(out?.findings.map((x) => [x.id, x.carried])).toEqual([
      [1, false],
      [50, true],
    ]);
    expect((out as { teammate?: unknown }).teammate).toBeUndefined();
  });

  it('with no previous review the newest block anchors, naming the teammate', () => {
    const out = mergeStandingBlocks(null, [block]);
    expect(out).toMatchObject({ reviewId: 20, teammate: { login: 'robin-dunn' } });
    expect(out?.findings.map((x) => x.carried)).toEqual([false, false]);
  });

  it('no block: the prior is returned unchanged (same object)', () => {
    const prior = { reviewId: 10, headSha: 'a'.repeat(40), findings: [] };
    expect(mergeStandingBlocks(prior, [])).toBe(prior);
  });
});

// PR 221270 (DEFRA/bng-metric-frontend#474): Robin's replies pass APPROVED at 14:05 (marker d=APPROVE),
// his auto review withdrew it at 16:41 and posted a Comment 4 seconds later. The approval must not
// vanish: the standing row keeps a note, and the review list keeps the verdict, withdrawn.
describe('a withdrawn Limn verdict (migration 0183)', () => {
  const dismissedApprove = (over: Partial<StandingGithubReview> = {}) =>
    gh(2, 'RV_5826965513', 'dismissed', '2026-11-09T14:05:09Z', {
      markerVerdict: 'APPROVE',
      dismissedAt: t('2026-11-09T16:41:46Z'),
      dismissalMessage: 'Limn withdrew its approval: 3 warnings found at 951c4aa.',
      ...over,
    });
  const laterComment = gh(2, 'RV_5829226544', 'commented', '2026-11-09T16:41:50Z');

  it('decisive, then dismissed, then a Comment: the withdrawal survives the newer Comment', () => {
    expect(withdrawnVerdict([dismissedApprove(), laterComment])).toEqual({
      verdict: 'APPROVE',
      postedAt: '2026-11-09T14:05:09.000Z',
      headSha: null,
      at: '2026-11-09T16:41:46.000Z',
      byLimn: true,
      reason: '3 warnings found at 951c4aa',
    });
    // The marker's commit, when the loader read one.
    expect(withdrawnVerdict([dismissedApprove({ markerHead: 'f'.repeat(40) })])?.headSha).toBe('f'.repeat(40));
    const input = base();
    input.teammates = [{ reviewId: 1419, poster: ROBIN, verdict: 'COMMENT', at: t('2026-11-09T16:41:50Z'), headSha: '951c4aa'.padEnd(40, '0'), nodeId: 'RV_5829226544' }];
    input.github = [gh(ME, 'RV_601', 'changes_requested', '2026-11-03T10:00:00Z'), dismissedApprove(), laterComment];
    const robin = teamStandings(input).reviewers.find((r) => !r.you)!;
    expect(robin).toMatchObject({ inForce: null, dismissed: false, withdrawn: { verdict: 'APPROVE', byLimn: true } });
  });

  it('a later decisive review replaces it; an older Limn without d= is withdrawn with no verdict; a person’s dismissal is "not Limn"', () => {
    expect(withdrawnVerdict([dismissedApprove(), gh(2, 'RV_9', 'approved', '2026-11-09T17:00:00Z')])).toBeNull();
    expect(withdrawnVerdict([dismissedApprove({ markerVerdict: null, dismissalMessage: null, dismissedAt: null })])).toMatchObject({
      verdict: null,
      at: null,
      byLimn: null,
      reason: null,
    });
    expect(withdrawnVerdict([dismissedApprove({ dismissalMessage: 'Stale.' })])).toMatchObject({ byLimn: false, reason: 'Stale' });
    // A person's own dismissed review (no Limn marker) is never Limn's.
    expect(withdrawnVerdict([dismissedApprove({ limn: false })])).toBeNull();
  });

  it('the decisions fold: a decisive replies pass is listed, a Comment one is not; a dismissed review carries its withdrawal', () => {
    const marker = (k: string, d: string) => `body\n\n<!-- pierre:claude-review v=1 a=x h=7f8ea893 k=${k} d=${d} lv=1.0.13 -->`;
    const row = (nodeId: string, state: DecisionReviewInput['state'], body: string | null, over: Partial<DecisionReviewInput> = {}): DecisionReviewInput => ({
      nodeId,
      databaseId: nodeId.replace(/\D/g, ''),
      authorId: 2,
      state,
      submittedAt: t('2026-11-09T14:05:09Z'),
      body,
      dismissedAt: null,
      dismissalMessage: null,
      ...over,
    });
    const out = teamDecisions({
      reviews: [
        row('RV_1', 'dismissed', marker('replies', 'APPROVE'), {
          dismissedAt: t('2026-11-09T16:41:46Z'),
          dismissalMessage: 'Limn withdrew its approval: 3 warnings found at 951c4aa.',
        }),
        row('RV_2', 'commented', marker('replies', 'COMMENT')),
        row('RV_3', 'approved', marker('replies', 'APPROVE'), { authorId: ME, submittedAt: t('2026-11-08T10:00:00Z') }),
        row('RV_4', 'changes_requested', marker('auto', 'REQUEST_CHANGES')),
        row('RV_5', 'dismissed', 'LGTM'),
        row('RV_6', 'dismissed', marker('auto', 'REQUEST_CHANGES'), { submittedAt: t('2026-11-07T10:00:00Z') }),
      ],
      readerUserIds: new Set([ME]),
      posters: new Map([[2, ROBIN]]),
      ownPosted: new Map([['3', 77]]),
      teammateByNode: new Map([['RV_6', 1364]]),
      prUrl: 'https://github.com/DEFRA/bng-metric-frontend/pull/474',
    });
    expect(out.map((d) => [d.key, d.verdict, d.run, d.ref, d.withdrawn?.byLimn ?? null])).toEqual([
      ['RV_1', 'APPROVE', 'replies', null, true],
      ['RV_3', 'APPROVE', 'replies', { kind: 'own', id: 77 }, null],
      ['RV_6', 'REQUEST_CHANGES', 'auto', { kind: 'teammate', reviewId: 1364 }, null],
    ]);
    expect(out[0]).toMatchObject({
      poster: { login: 'robin-dunn' },
      headSha: '7f8ea893',
      githubUrl: 'https://github.com/DEFRA/bng-metric-frontend/pull/474#pullrequestreview-1',
      withdrawn: { reason: '3 warnings found at 951c4aa', at: '2026-11-09T16:41:46.000Z' },
    });
  });
});

describe('the team hold on a replies pass’s APPROVE (decision 2026-11-09)', () => {
  const since = t('2026-11-09T13:00:00Z');
  it('a teammate’s newer "still open" on a point the pass settled holds it; older or addressed does not', () => {
    const settled = new Set(['4512556766']);
    expect(
      teammateStillOpenHold(settled, [{ login: 'alexwakeman', at: t('2026-11-09T13:30:00Z'), judged: [{ commentId: '4512556766', outcome: 'still_open' }] }], since),
    ).toEqual({ heldReason: 'team_open', text: 'Not approved: alexwakeman’s Limn judged a point still open.' });
    // Older than the full review: not a newer judgement.
    expect(
      teammateStillOpenHold(settled, [{ login: 'alexwakeman', at: t('2026-11-09T12:00:00Z'), judged: [{ commentId: '4512556766', outcome: 'not_addressed' }] }], since),
    ).toBeNull();
    // The newest judgement of the point wins: a later "addressed" settles it.
    expect(
      teammateStillOpenHold(
        settled,
        [
          { login: 'alexwakeman', at: t('2026-11-09T13:30:00Z'), judged: [{ commentId: '4512556766', outcome: 'not_addressed' }] },
          { login: 'sam-li', at: t('2026-11-09T13:40:00Z'), judged: [{ commentId: '4512556766', outcome: 'addressed' }] },
        ],
        since,
      ),
    ).toBeNull();
    // A point the pass did not settle never holds it.
    expect(
      teammateStillOpenHold(settled, [{ login: 'alexwakeman', at: t('2026-11-09T13:30:00Z'), judged: [{ commentId: '1', outcome: 'still_open' }] }], since),
    ).toBeNull();
  });
});
