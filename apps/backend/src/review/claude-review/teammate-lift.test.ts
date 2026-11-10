// LIFTING A TEAMMATE'S LIMN BLOCK (docs/CLAUDE-REVIEW.md § Lifting a teammate's block). Throwaway
// sqlite, the REAL persistPr + teammate import, a FAKE GitHub (postReview, the live PR, the live
// reviews and the dismissal are recorded stubs). What this pins:
//   1. All conditions met ⇒ the reader's review goes out (COMMENT, or APPROVE when the auto verdict and
//      its gate allow), carrying the judgements, then ONE dismissal of the teammate's review with the
//      plain message; recorded on the teammate's row and on the run; the PR is settled.
//   2. Each missing condition holds it: the lifting setting off, no consent in the post, a point not
//      addressed, a blocker in the reader's own run, the head moved, the reader's own PR.
//   3. A review without Limn's marker (a person's typed Request changes) is NEVER dismissed.
//   4. The claim: a teammate review is tried once, ever — a second run never dismisses it again.
//   5. A refusal (403) is recorded in GitHub's words and never retried.
//
//   pnpm --filter @pierre-review/backend test claude-review/teammate-lift
import { describe, expect, it } from 'vitest';
import { AUTO_POST_DEFAULT_KINDS, parseLimnReviewMarker } from '@pierre-review/shared';
import {
  ALICE,
  HEAD,
  allAddressed,
  autoPostOf,
  blockedPr,
  dismissReview,
  go,
  live,
  postReview,
  readerRun,
  robinSummary,
  setPost,
  settle,
  teammateLiftOf,
  useLiftFixture,
} from './teammate-lift.test-support.js';
import * as F from './teammate-lift.test-support.js';

useLiftFixture('pierre-teammate-lift-test');

describe('the pure rules', () => {
  it('the marker carries the consent as lift=1, and only when given', () => {
    expect(robinSummary(true)).toContain(' lift=1 ');
    expect(parseLimnReviewMarker(robinSummary(true))?.liftConsent).toBe(true);
    expect(robinSummary(false)).not.toContain('lift=');
    expect(parseLimnReviewMarker(robinSummary(false))?.liftConsent).toBeUndefined();
  });

  it('the points behind a block: blockers, warnings and unlabelled always; nits / questions by the approve rule', () => {
    const fs = [
      { id: 1, severity: 'blocker' as const },
      { id: 2, severity: 'warning' as const },
      { id: 3, severity: 'nit' as const },
      { id: 4, severity: 'question' as const },
      { id: 5, severity: null },
      { id: 6, severity: 'praise' as const },
    ];
    expect(F.lift.pointsBehindBlock(fs, 'nits_questions').map((f) => f.id)).toEqual([1, 2, 5]);
    expect(F.lift.pointsBehindBlock(fs, 'nits').map((f) => f.id)).toEqual([1, 2, 4, 5]);
    expect(F.lift.pointsBehindBlock(fs, 'none').map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    // ⚠ FAIL SAFE: a REQUEST_CHANGES whose comments hold no blocker, warning or unlabelled finding
    // rests on something they do not show (a blocker posted earlier): no points, never lifted — not
    // even under the strictest approve rule. A block with no findings has no points.
    expect(F.lift.pointsBehindBlock([{ id: 3, severity: 'nit' }], 'nits_questions')).toEqual([]);
    expect(F.lift.pointsBehindBlock([{ id: 3, severity: 'nit' }, { id: 4, severity: 'question' }], 'none')).toEqual([]);
    expect(F.lift.pointsBehindBlock([], 'none')).toEqual([]);
  });

  it('judgements hold only at the head they read; a reply accepted holds across heads', () => {
    const run = (headSha: string, items: Array<[number, string]>) => ({
      headSha,
      followUp: { items: items.map(([priorFindingId, status]) => ({ priorFindingId, status })) },
    });
    const w = F.lift.wordsAtHead(
      [
        run('H1', [[1, 'addressed'], [2, 'reply_accepted'], [3, 'addressed']]),
        run('H2', [[3, 'not_addressed'], [4, 'addressed']]),
        run('H3', [[4, 'not_checked'], [5, 'addressed']]),
      ],
      'H3',
    );
    // 1: addressed at H1 only — does not hold at H3. 2: a reply accepted holds. 3: cleared by H2's word.
    // 4: H2's code judgement does not hold at H3 (and 'not_checked' never counts). 5: judged here.
    expect([...w.entries()]).toEqual([[2, 'reply_accepted'], [5, 'addressed']]);
    // No head to hold to: every run counts.
    expect(F.lift.wordsAtHead([run('H1', [[1, 'addressed']])], null).get(1)).toBe('addressed');
  });

  it('the poster’s consent rides only a post whose comments hold every blocker behind it', () => {
    const f = (id: number, severity: string, more: Record<string, unknown> = {}) => ({ id, severity, included: true, story: null, ...more }) as any;
    expect(F.ap.blockersAllInPost([f(1, 'blocker'), f(2, 'nit')], [f(1, 'blocker')])).toBe(true);
    // The blocker was posted in an EARLIER review, so this post's comments hold only the nit.
    expect(F.ap.blockersAllInPost([f(1, 'blocker'), f(2, 'nit')], [f(2, 'nit')])).toBe(false);
    // A blocker the reader ignored does not count (the verdict does not count it either).
    expect(F.ap.blockersAllInPost([f(1, 'blocker', { included: false }), f(2, 'nit')], [f(2, 'nit')])).toBe(true);
    expect(F.ap.blockersAllInPost([f(2, 'warning')], [])).toBe(true);
  });

  it('the message names the reader, the count and the commit', () => {
    expect(F.lift.teammateLiftMessage('alex', 3, '70cc9b5aaaa')).toBe('Limn (alex) checked all 3 points are addressed at 70cc9b5.');
    expect(F.lift.teammateLiftMessage('alex', 1, '70cc9b5aaaa')).toBe('Limn (alex) checked the 1 point is addressed at 70cc9b5.');
  });

  it('the live check: standing, Limn-marked, consented — a later COMMENTED review never replaces it', () => {
    const c = { githubReviewId: '7', login: 'robin-dev' };
    const ok = [{ id: 7, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: robinSummary(true) }, { id: 8, login: 'robin-dev', state: 'COMMENTED', body: 'x' }];
    expect(F.lift.liveLiftCheck(ok, c, 'alice-dev')).toBeNull();
    expect(F.lift.liveLiftCheck([{ ...ok[0]!, body: 'Please fix the lock.' }], c, 'alice-dev')).toBe('not_limn');
    expect(F.lift.liveLiftCheck([{ ...ok[0]!, body: robinSummary(false) }], c, 'alice-dev')).toBe('no_consent');
    expect(F.lift.liveLiftCheck([...ok, { id: 9, login: 'robin-dev', state: 'DISMISSED', body: '' }], c, 'alice-dev')).toBe('not_in_force');
    expect(F.lift.liveLiftCheck([...ok, { id: 9, login: 'robin-dev', state: 'APPROVED', body: '' }], c, 'alice-dev')).toBe('not_in_force');
    expect(F.lift.liveLiftCheck(ok, c, 'robin-dev')).toBe('own_review');
    expect(F.lift.liveLiftCheck([], c, 'alice-dev')).toBe('not_in_force');
  });
});

describe("lifting a teammate's Limn block", () => {
  it('all conditions met: the reader posts, then dismisses robin’s review ONCE with the plain message', async () => {
    const { prId, teammateId, findings, ghId } = await blockedPr();
    expect(findings).toHaveLength(3);
    const run = await readerRun(prId, allAddressed(findings));
    const out = await go(prId, run);
    expect(out.kind).toBe('done');
    // The reader's own review went out first: COMMENT (the auto verdict is off), with the judgements
    // and the reader's consent (always given since 2026-11-10: no blocker is left out) in its marker.
    expect(postReview).toHaveBeenCalledTimes(1);
    const posted = postReview.mock.calls[0]![0];
    expect(posted.verdict).toBe('COMMENT');
    expect(posted.limnMeta.judged.map((j: any) => j.outcome)).toEqual(['addressed', 'addressed', 'addressed']);
    expect(posted.limnMeta.liftConsent).toBe(true);
    // Then the dismissal. The nit is left out of the count (the default approve rule lets nits stay).
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview.mock.calls[0]!.slice(1)).toEqual([
      'acme',
      'lift',
      F.prSeq,
      ghId,
      'Limn (alice-dev) checked all 2 points are addressed at bbbbbbb.',
    ]);
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'dismissed', byReviewId: run, points: 2, error: null, headSha: HEAD });
    expect(await autoPostOf(run)).toMatchObject({
      status: 'posted',
      liftedTeammateBlocks: [{ teammateReviewId: teammateId, login: 'robin-dev', status: 'dismissed', error: null }],
    });
    expect(settle).toHaveBeenCalled();
    // The local review row is stamped dismissed: robin's block no longer stands.
    const { eq } = await import('drizzle-orm');
    const rv = await F.db.select({ state: F.schema.reviews.state }).from(F.schema.reviews).where(eq(F.schema.reviews.databaseId, ghId)).execute();
    expect(rv[0].state).toBe('dismissed');

    // A later run never dismisses it again.
    dismissReview.mockClear();
    const again = await readerRun(prId, allAddressed(findings));
    await go(prId, again);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('with the auto verdict on and nothing open, the reader’s review is an APPROVE', async () => {
    await setPost({ autoVerdict: true });
    const { prId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings), { verdict: 'APPROVE' });
    await go(prId, run);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
    expect(dismissReview).toHaveBeenCalledTimes(1);
  });

  it('a nit the reader’s approve rule does not allow open must be settled too', async () => {
    await setPost({ approveLeftovers: 'none' });
    const { prId, findings } = await blockedPr();
    const nit = findings.find((f: any) => f.severity === 'nit');
    const run = await readerRun(prId, findings.map((f: any) => ({ id: f.id, status: f.id === nit.id ? 'not_addressed' : 'addressed' })));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    await setPost({ approveLeftovers: 'nits_questions' });
  });

  it('no consent in robin’s post: never dismissed', async () => {
    const { prId, findings } = await blockedPr({ consent: false });
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a point not addressed (or not checked) holds it', async () => {
    const { prId, findings } = await blockedPr();
    const blocker = findings.find((f: any) => f.severity === 'blocker');
    const run = await readerRun(prId, findings.map((f: any) => ({ id: f.id, status: f.id === blocker.id ? 'not_checked' : 'addressed' })));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    const run2 = await readerRun(prId, findings.map((f: any) => ({ id: f.id, status: f.id === blocker.id ? 'not_addressed' : 'addressed' })));
    await go(prId, run2);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a point settled by an EARLIER run of the reader counts (it is not sent again)', async () => {
    const { prId, findings } = await blockedPr();
    const [first, ...rest] = findings;
    const early = await readerRun(prId, [{ id: first.id, status: 'no_longer_applies' }]);
    await F.db.update(F.schema.claudeReviews).set({ autoPost: { status: 'skipped' } }).where((await import('drizzle-orm')).eq(F.schema.claudeReviews.id, early)).execute();
    const run = await readerRun(prId, rest.map((f: any) => ({ id: f.id, status: 'addressed' })));
    await go(prId, run);
    expect(dismissReview).toHaveBeenCalledTimes(1);
  });

  it('a point judged addressed only at an OLDER head never lifts the block (a push can undo the fix)', async () => {
    const OLD = 'a'.repeat(40);
    const { prId, findings } = await blockedPr();
    const [first, ...rest] = findings;
    const early = await readerRun(prId, [{ id: first.id, status: 'addressed' }], { head: OLD });
    await F.db.update(F.schema.claudeReviews).set({ autoPost: { status: 'skipped' } }).where((await import('drizzle-orm')).eq(F.schema.claudeReviews.id, early)).execute();
    // The follow-up at HEAD gets the point again: it is not settled here.
    const { loadStandingBlockAnchors } = await import('./teammate-anchor.js');
    const blocks = await loadStandingBlockAnchors(F.ctx, prId, 1, null, HEAD);
    expect(blocks[0]!.findings.map((x) => x.id)).toContain(first.id);
    // Judged at the old head only (this run left it out): held.
    const run = await readerRun(prId, rest.map((f: any) => ({ id: f.id, status: 'addressed' })));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    // Settled points at the head being read are not sent again.
    expect((await loadStandingBlockAnchors(F.ctx, prId, 1, null, HEAD))[0]!.findings.map((x) => x.id)).toEqual([first.id]);
  });

  it('the poster’s own post withholds lift=1 when a blocker behind its verdict was posted earlier', async () => {
    await setPost({ autoVerdict: true, kinds: { ...AUTO_POST_DEFAULT_KINDS, nits: true } });
    const { prId } = await blockedPr();
    const r1 = await readerRun(prId, [], { findings: [{ severity: 'blocker', title: 'Lock leak' }] });
    await go(prId, r1);
    expect(postReview.mock.calls[0]![0].limnMeta.liftConsent).toBe(true);
    // The next run raises the same blocker again (already on GitHub, so left out) and a new nit.
    postReview.mockClear();
    const r2 = await readerRun(prId, [], { findings: [{ severity: 'blocker', title: 'Lock leak' }, { severity: 'nit', title: 'Rename x' }] });
    await go(prId, r2);
    const posted = postReview.mock.calls[0]![0];
    expect(posted.verdict).toBe('REQUEST_CHANGES');
    expect(posted.includedFindings.map((x: any) => x.severity)).toEqual(['nit']);
    expect(posted.limnMeta.liftConsent).toBe(false);
    await setPost({ autoVerdict: false, kinds: AUTO_POST_DEFAULT_KINDS });
  });

  it('a blocker in the reader’s own run holds it', async () => {
    const { prId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings), { findings: [{ severity: 'blocker', title: 'New race' }] });
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('the head moved since the run: no review, no dismissal', async () => {
    const { prId, teammateId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings));
    live.head = 'c'.repeat(40);
    const out = await go(prId, run);
    expect(out).toMatchObject({ kind: 'done', record: { status: 'failed' } });
    expect(postReview).not.toHaveBeenCalled();
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toBeNull();
  });

  it('the reader’s own PR: never', async () => {
    const { prId, findings } = await blockedPr({ author: ALICE });
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a person’s typed Request changes (no Limn marker) is never dismissed', async () => {
    const { prId, findings, ghId } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings));
    // On GitHub now: the same review id, but its body has no marker (edited by hand) …
    live.list = [{ id: ghId, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: 'Please fix the lock first.' }];
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    // … or robin typed a newer Request changes of his own.
    const run2 = await readerRun(prId, allAddressed(findings));
    live.list = [
      { id: ghId, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: robinSummary(true) },
      { id: 77, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: 'Still not right.' },
    ];
    await go(prId, run2);
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('the claim: a teammate review already claimed is never dismissed again', async () => {
    const { prId, teammateId, findings } = await blockedPr();
    // Another run claimed it (and was cut off mid-write).
    expect(await F.lift.claimTeammateLift(F.ctx, 1, teammateId, { byReviewId: 1, headSha: HEAD, points: 2, message: 'm' })).toBe(true);
    expect(await F.lift.claimTeammateLift(F.ctx, 1, teammateId, { byReviewId: 2, headSha: HEAD, points: 2, message: 'm' })).toBe(false);
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'dismissing', byReviewId: 1 });
  });

  it('a refusal (403) is recorded in GitHub’s words and never retried', async () => {
    dismissReview.mockImplementation(async () => ({ ok: false, message: 'Must have admin rights to Repository.' }));
    const { prId, teammateId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'failed', error: 'Must have admin rights to Repository.' });
    // The reader's review itself landed.
    expect(await autoPostOf(run)).toMatchObject({
      status: 'posted',
      liftedTeammateBlocks: [{ status: 'failed', error: 'Must have admin rights to Repository.' }],
    });
    dismissReview.mockClear();
    const again = await readerRun(prId, allAddressed(findings));
    await go(prId, again);
    expect(dismissReview).not.toHaveBeenCalled();
    // The teammate review shows the attempt (the AI Review tab reads it).
    const { listTeammateReviews } = await import('../../db/teammate-reviews.js');
    const listed = await listTeammateReviews(F.db, 1, prId);
    expect(listed[0]!.lift).toMatchObject({ status: 'failed', error: 'Must have admin rights to Repository.' });
  });

  it('the consent rides the reader’s own posts, with no setting (always on since 2026-11-10)', async () => {
    const { prId, findings } = await blockedPr();
    const run = await readerRun(prId, allAddressed(findings));
    await go(prId, run);
    expect(postReview.mock.calls[0]![0].limnMeta.liftConsent).toBe(true);
  });
});

// THE AWAY PATH (2026-11-10; docs/TEAM-REVIEW.md § 5 "When the teammate is away"): no opt-in on
// either side; the reader's review APPROVES, every point behind robin's block is settled at the head,
// and robin's Limn is away — no line at the head, nothing seen for TEAMMATE_AWAY_AFTER_MS.
