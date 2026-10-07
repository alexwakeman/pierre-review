// SETTLED BY A REPLY — the pure rules (settled-by-reply.ts + follow-up.ts). What this pins:
//   1. ⚠ a thread RESOLVED after a person's reply is NO LONGER settled on sight: it is a finding
//      to JUDGE (`isResolvedWithReplies`), selected AFTER the open ones so its replies cannot crowd
//      an open finding out of the cap; resolved with NO reply is an ordinary finding, as before;
//   2. only an ACCEPTED reply ('reply_accepted') settles a finding, the first acceptance wins, and
//      the read path's fields (severity, anchor, accepting run) ride along;
//   3. BACKWARD COMPATIBILITY: a finding the retired rule took out of the chain (posted, no closing
//      status, not continued by a posted re-raise, not already in this run) is a candidate again;
//   4. a new finding repeating a settled one (same path, similar title) is dropped; one linked to a
//      still-open earlier finding is kept.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import {
  acceptedReplyFindings,
  dropSettledReraises,
  similarTitles,
  unjudgedReplyCandidateIds,
  UNJUDGED_REPLY_MAX,
} from './settled-by-reply.js';
import {
  isResolvedWithReplies,
  reconcileFollowUp,
  selectPriorFindings,
  PRIOR_FINDINGS_MAX,
  type PriorFindingForFollowUp,
} from './follow-up.js';

const HEAD = 'a'.repeat(40);
const REPLY = { author: 'alice-dev', body: 'Intentional: `user` is validated upstream.', at: '2026-10-01T10:00:00.000Z' };

const prior = (over: Partial<PriorFindingForFollowUp> = {}): PriorFindingForFollowUp => ({
  id: 1,
  headSha: HEAD,
  path: 'src/a.ts',
  line: 3,
  side: 'RIGHT',
  severity: 'warning',
  title: 'Null dereference',
  body: 'body',
  suggestion: null,
  diffHunk: null,
  anchored: true,
  fileInDiff: true,
  posted: true,
  carried: false,
  ...over,
});
const thread = (over: Partial<NonNullable<PriorFindingForFollowUp['thread']>> = {}) => ({
  threadId: 9,
  threadFindingId: 1,
  replies: [REPLY],
  pushedBack: false,
  isResolved: true,
  resolvedBy: 'alice-dev',
  ...over,
});

describe('a resolved thread with a reply is judged, not settled', () => {
  it('resolved + a person\'s reply ⇒ judged; no reply, an open thread or only Limn\'s reply ⇒ not this path', () => {
    expect(isResolvedWithReplies(prior({ thread: thread() }))).toBe(true);
    expect(isResolvedWithReplies(prior({ thread: thread({ replies: [] }) }))).toBe(false);
    expect(isResolvedWithReplies(prior({ thread: thread({ isResolved: false }) }))).toBe(false);
    expect(isResolvedWithReplies(prior({ thread: thread({ replies: [{ ...REPLY, fromLimn: true }] }) }))).toBe(false);
    expect(isResolvedWithReplies(prior({ thread: null }))).toBe(false);
  });

  it('is SENT (not dropped), after every open finding — own, then carried', () => {
    const resolvedBlocker = prior({ id: 1, severity: 'blocker', thread: thread() });
    const openNit = prior({ id: 2, severity: 'nit' });
    const carriedOpen = prior({ id: 3, carried: true });
    const carriedResolved = prior({ id: 4, carried: true, severity: 'blocker', thread: thread({ threadId: 10 }) });
    const resolvedNoReply = prior({ id: 5, severity: 'question', thread: thread({ threadId: 11, replies: [] }) });
    const plan = selectPriorFindings(
      { reviewId: 1, headSha: 'b'.repeat(40), findings: [resolvedBlocker, openNit, carriedOpen, carriedResolved, resolvedNoReply] },
      HEAD,
    );
    // A thread resolved with NO reply keeps its ordinary place (a question before a nit).
    expect(plan.sent.map((s) => s.finding.id)).toEqual([5, 2, 3, 1, 4]);
    expect(plan.omitted).toEqual([]);
  });

  it('under the cap, the resolved-with-reply ones are the ones left out (not checked, carried)', () => {
    const open = Array.from({ length: PRIOR_FINDINGS_MAX }, (_, i) => prior({ id: 100 + i, severity: 'nit' }));
    const resolved = prior({ id: 1, severity: 'blocker', thread: thread() });
    const plan = selectPriorFindings({ reviewId: 1, headSha: HEAD, findings: [resolved, ...open] }, HEAD);
    expect(plan.sent).toHaveLength(PRIOR_FINDINGS_MAX);
    expect(plan.omitted.map((f) => f.id)).toEqual([1]);
  });
});

describe('the same-head lock never decides an unjudged resolved reply', () => {
  it("unreported ⇒ 'not_checked' (carried, not counted), not the lock's 'not_addressed'; a reported code status is still locked", () => {
    const resolved = prior({ id: 1, thread: thread() });
    const open = prior({ id: 2 });
    const plan = selectPriorFindings({ reviewId: 1, headSha: HEAD, findings: [resolved, open] }, HEAD);
    const quiet = reconcileFollowUp(plan, []);
    expect(quiet.map((it) => [it.priorFindingId, it.status])).toEqual([
      [2, 'not_addressed'],
      [1, 'not_checked'],
    ]);
    const ref = plan.sent.find((s) => s.finding.id === 1)!.ref;
    const said = reconcileFollowUp(plan, [{ ref, status: 'addressed', explanation: 'x' } as any]);
    expect(said.find((it) => it.priorFindingId === 1)).toMatchObject({ status: 'not_addressed', statusCarried: true });
    const judged = reconcileFollowUp(plan, [{ ref, status: 'reply_disputed', reply: 'No.' } as any]);
    expect(judged.find((it) => it.priorFindingId === 1)).toMatchObject({ status: 'reply_disputed' });
  });
});

describe('acceptedReplyFindings — only an accepted reply settles', () => {
  const item = (over: object = {}) => ({
    priorFindingId: 7,
    status: 'reply_accepted',
    path: 'src/a.ts',
    title: 'Null deref',
    acceptKind: 'deferred' as const,
    reply: { author: 'alice-dev', excerpt: 'Follow-up PR.' },
    line: 3,
    side: 'RIGHT' as const,
    severity: 'warning' as const,
    reviewId: 5,
    ...over,
  });

  it('settles the accepted one with what the read path shows; the first acceptance wins', () => {
    const out = acceptedReplyFindings(
      [item(), item({ acceptKind: 'not_valid', reviewId: 6 }), item({ priorFindingId: 8, status: 'reply_disputed' })],
      new Set([7, 8]),
    );
    expect(out).toEqual([
      {
        id: 7,
        path: 'src/a.ts',
        title: 'Null deref',
        replyAuthor: 'alice-dev',
        reply: 'Follow-up PR.',
        acceptKind: 'deferred',
        line: 3,
        side: 'RIGHT',
        severity: 'warning',
        acceptedInReviewId: 5,
      },
    ]);
  });

  it('a finding outside the eligible set (another PR, unposted) is never settled', () => {
    expect(acceptedReplyFindings([item()], new Set([99]))).toEqual([]);
  });
});

describe('findings the retired rule took out of the chain', () => {
  const f = (id: number, over: object = {}) => ({ id, priorFindingId: null as number | null, eligible: true, ...over });

  it('a posted finding with no closing status, not continued and not already loaded, is a candidate again', () => {
    expect(unjudgedReplyCandidateIds([f(1)], [], new Set())).toEqual([1]);
    // Its last word was still open ⇒ still a candidate.
    expect(unjudgedReplyCandidateIds([f(1)], [{ priorFindingId: 1, status: 'not_addressed' }], new Set())).toEqual([1]);
  });

  it('closed by a follow-up, already in this run, settled, unposted or continued by a posted re-raise ⇒ not', () => {
    for (const st of ['addressed', 'no_longer_applies', 'reply_accepted']) {
      expect(unjudgedReplyCandidateIds([f(1)], [{ priorFindingId: 1, status: st }], new Set())).toEqual([]);
    }
    // The NEWEST item decides: closed, then re-opened later.
    expect(
      unjudgedReplyCandidateIds([f(1)], [{ priorFindingId: 1, status: 'addressed' }, { priorFindingId: 1, status: 'not_addressed' }], new Set()),
    ).toEqual([1]);
    expect(unjudgedReplyCandidateIds([f(1)], [], new Set([1]))).toEqual([]);
    expect(unjudgedReplyCandidateIds([f(1, { eligible: false })], [], new Set())).toEqual([]);
    expect(unjudgedReplyCandidateIds([f(1), f(2, { priorFindingId: 1 })], [], new Set([2]))).toEqual([]);
    // …but an UNPOSTED re-raise does not continue the chain.
    expect(unjudgedReplyCandidateIds([f(1), f(2, { priorFindingId: 1, eligible: false })], [], new Set())).toEqual([1]);
  });

  it('oldest first, capped', () => {
    const many = Array.from({ length: UNJUDGED_REPLY_MAX + 5 }, (_, i) => f(500 - i));
    const out = unjudgedReplyCandidateIds(many, [], new Set());
    expect(out).toHaveLength(UNJUDGED_REPLY_MAX);
    expect(out[0]).toBe(500 - (UNJUDGED_REPLY_MAX + 4));
  });
});

describe('re-raise of a settled finding', () => {
  const settled = [{ id: 7, path: 'src/a.ts', title: 'Null dereference of `user` in loadUser' }];

  it('similar titles: folded equality or word overlap', () => {
    expect(similarTitles('Null dereference of `user` in loadUser', 'null dereference of user in loadUser.')).toBe(true);
    expect(similarTitles('Null dereference of user in loadUser', 'Possible null dereference of user in loadUser')).toBe(true);
    expect(similarTitles('Null dereference of user in loadUser', 'SQL injection in the search query')).toBe(false);
  });

  it('drops an unlinked repeat on the same path; keeps another path, another point and a linked re-raise', () => {
    const repeat = { path: 'src/a.ts', title: 'Possible null dereference of user in loadUser', priorFindingId: null };
    const otherPath = { path: 'src/b.ts', title: 'Null dereference of user in loadUser', priorFindingId: null };
    const otherPoint = { path: 'src/a.ts', title: 'Missing await on save()', priorFindingId: null };
    const linked = { path: 'src/a.ts', title: 'Null dereference of user in loadUser', priorFindingId: 3 };
    const { kept, dropped } = dropSettledReraises([repeat, otherPath, otherPoint, linked], settled);
    expect(dropped).toEqual([repeat]);
    expect(kept).toEqual([otherPath, otherPoint, linked]);
  });

  it('nothing settled ⇒ everything kept', () => {
    const f = { path: 'src/a.ts', title: 'x', priorFindingId: null };
    expect(dropSettledReraises([f], [])).toEqual({ kept: [f], dropped: [] });
  });
});
