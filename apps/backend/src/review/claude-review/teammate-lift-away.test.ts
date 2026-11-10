// DISMISSING AN AWAY TEAMMATE'S LIMN BLOCK (docs/TEAM-REVIEW.md § 5 "When the teammate's Limn is
// away"; docs/CLAUDE-REVIEW.md § Lifting a teammate's block → THE AWAY PATH). Same fixture as
// teammate-lift.test.ts (teammate-lift.test-support.ts).
//
//   pnpm --filter @pierre-review/backend test claude-review/teammate-lift-away
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { limnReviewMarker } from '@pierre-review/shared';
import {
  ALICE,
  HEAD,
  ROBIN,
  allAddressed,
  autoPostOf,
  blockedPr,
  deps,
  dismissReview,
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

useLiftFixture('pierre-teammate-lift-away-test');

/** robin's Limn review sent with the Post button: Limn's marker, run kind manual. */
const manualSummary = (consent = false, headSha: string = 'a'.repeat(40)): string =>
  `Two things to fix before this lands.\n\n${limnReviewMarker('mm22', {
    headSha,
    run: 'manual',
    pair: false,
    runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }],
    verdict: 'REQUEST_CHANGES',
    limnVersion: '0.1.180',
    liftConsent: consent,
  })}`;

describe("dismissing an away teammate's Limn block", () => {
  // robin's review was posted 2026-11-03T10:00Z; a day later his Limn has been quiet for 24 hours.
  const DAY_LATER = Date.parse('2026-11-04T10:00:00Z');
  // robin's Limn reviewed an OLDER commit; the PR is now at HEAD, which his Limn has not looked at.
  const OLD_HEAD = 'a'.repeat(40);
  let now = DAY_LATER;
  let lines: Array<{ login: string | null }> | null = [];
  const liveTeamLines = vi.fn(async () => lines);
  const awayDeps = () => ({ ...deps(), liveTeamLines, nowMs: () => now });
  const goAway = (prId: number, reviewId: number) => F.ap.maybeAutoPostReview(F.ctx, { accountId: 1, prId, reviewId }, awayDeps());
  const approveRun = (prId: number, findings: any[], judged = allAddressed(findings)) => readerRun(prId, judged, { verdict: 'APPROVE' });

  beforeEach(async () => {
    now = DAY_LATER;
    lines = [{ login: 'alice-dev' }];
    liveTeamLines.mockClear();
    // Neither opt-in: robin gave no consent, the reader has not ticked "Dismiss a teammate's …".
    await setPost({ liftTeammateBlocks: false, teamLiftConsent: false, autoVerdict: true });
  });

  it('the pure rules: away only with no line at the head and nothing seen for the window', () => {
    const at = Date.parse('2026-11-03T10:00:00Z');
    expect(F.lift.teammateAwayHold({ activeAtHead: false, lastSeenMs: at, nowMs: at + F.lift.TEAMMATE_AWAY_AFTER_MS })).toBeNull();
    expect(F.lift.teammateAwayHold({ activeAtHead: false, lastSeenMs: at, nowMs: at + F.lift.TEAMMATE_AWAY_AFTER_MS - 1 })).toBe('teammate_recent');
    expect(F.lift.teammateAwayHold({ activeAtHead: true, lastSeenMs: null, nowMs: at })).toBe('teammate_active');
    expect(F.lift.teammateAwayHold({ activeAtHead: null, lastSeenMs: null, nowMs: at })).toBe('teammate_unknown');
    expect(F.lift.teammateLineAtHead([{ login: 'Robin-Dev' }], 'robin-dev')).toBe(true);
    expect(F.lift.teammateLineAtHead([{ login: 'alice-dev' }], 'robin-dev')).toBe(false);
    expect(F.lift.teammateLineAtHead(null, 'robin-dev')).toBeNull();
    // The away path needs an approving review; consent is not asked.
    const base = {
      why: 'away' as const,
      settingOn: false,
      authorIsMe: false,
      posterIsMe: false,
      inForce: true,
      alreadyTried: false,
      consent: false,
      limn: true,
      ownBlocker: false,
      atCurrentHead: true,
      points: [{ id: 1, severity: 'warning' as const }],
      words: new Map([[1, 'addressed']]),
      away: { activeAtHead: false, lastSeenMs: at, nowMs: DAY_LATER },
      auto: true,
    };
    expect(F.lift.teammateLiftHold({ ...base, approves: true })).toBeNull();
    expect(F.lift.teammateLiftHold({ ...base, approves: false })).toBe('not_approving');
    expect(F.lift.teammateLiftHold({ ...base, approves: true, limn: false })).toBe('not_limn');
    expect(F.lift.teammateLiftHold({ ...base, approves: true, words: new Map([[1, 'not_addressed']]) })).toBe('points_open');
    // A block their Limn sent through the Post button (or an older post with no run kind) is theirs.
    expect(F.lift.teammateLiftHold({ ...base, approves: true, auto: false })).toBe('not_auto');
    expect(F.lift.teammateLiftHold({ ...base, approves: true, auto: undefined })).toBe('not_auto');
  });

  it('the live check on the away path: no consent needed; a recent later review of theirs holds it', () => {
    const c = { githubReviewId: '7', login: 'robin-dev', why: 'away' as const };
    const block = { id: 7, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: robinSummary(false) };
    expect(F.lift.liveLiftCheck([block], c, 'alice-dev', DAY_LATER)).toBeNull();
    const reply = (at: string | null) => ({ id: 8, login: 'robin-dev', state: 'COMMENTED', body: '', submittedAt: at });
    expect(F.lift.liveLiftCheck([block, reply('2026-11-04T09:00:00Z')], c, 'alice-dev', DAY_LATER)).toBe('teammate_active');
    expect(F.lift.liveLiftCheck([block, reply(null)], c, 'alice-dev', DAY_LATER)).toBe('teammate_active');
    expect(F.lift.liveLiftCheck([block, reply('2026-11-03T11:00:00Z')], c, 'alice-dev', DAY_LATER)).toBeNull();
    // A person's typed review is never dismissed.
    expect(F.lift.liveLiftCheck([{ ...block, body: 'Please fix it.' }], c, 'alice-dev', DAY_LATER)).toBe('not_limn');
    // Nor one sent with the Post button: Limn's marker, but `k=manual` (their own judgement).
    expect(F.lift.liveLiftCheck([{ ...block, body: manualSummary() }], c, 'alice-dev', DAY_LATER)).toBe('not_auto');
    // The consent path is unchanged by the run kind (it reads lift=1).
    expect(F.lift.liveLiftCheck([{ ...block, body: manualSummary(true) }], { ...c, why: 'consent' }, 'alice-dev', DAY_LATER)).toBeNull();
  });

  it('the message keeps the Limn lead and says why', async () => {
    const { isLimnDismissalMessage } = await import('@pierre-review/shared');
    const m = F.lift.teammateAwayLiftMessage('alex', 'robin', 3, 'abc1234ffff', 5 * 3_600_000);
    expect(m).toBe("Limn (alex) checked all 3 points are addressed at abc1234. robin's Limn has not reviewed it and has been away for 5 hours.");
    expect(isLimnDismissalMessage(m)).toBe(true);
    expect(F.lift.awayFor(3 * 86_400_000)).toBe('3 days');
    expect(F.lift.teammateAwayLiftMessage('alex', 'robin', 1, 'abc1234', null)).toBe(
      "Limn (alex) checked the 1 point is addressed at abc1234. robin's Limn has not reviewed it.",
    );
  });

  it('every point settled and robin away: the reader approves, then dismisses robin’s review once', async () => {
    const { prId, teammateId, findings, ghId } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    const run = await approveRun(prId, findings);
    await goAway(prId, run);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(postReview.mock.calls[0]![0].verdict).toBe('APPROVE');
    expect(liveTeamLines).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview.mock.calls[0]!.slice(1)).toEqual([
      'acme',
      'lift',
      F.prSeq,
      ghId,
      "Limn (alice-dev) checked all 2 points are addressed at bbbbbbb. robin-dev's Limn has not reviewed it and has been away for 24 hours.",
    ]);
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'dismissed', why: 'away', points: 2 });
    expect(await autoPostOf(run)).toMatchObject({
      status: 'posted',
      liftedTeammateBlocks: [{ teammateReviewId: teammateId, login: 'robin-dev', status: 'dismissed', why: 'away' }],
    });
    expect(settle).toHaveBeenCalled();
    // Claimed once: a later approving run never dismisses it again.
    dismissReview.mockClear();
    await goAway(prId, await approveRun(prId, findings));
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a point still open holds it (the reader does not approve over it)', async () => {
    const { prId, teammateId, findings } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    const blocker = findings.find((f: any) => f.severity === 'blocker');
    const run = await approveRun(prId, findings, findings.map((f: any) => ({ id: f.id, status: f.id === blocker.id ? 'not_addressed' : 'addressed' })));
    await goAway(prId, run);
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toBeNull();
  });

  it('robin’s Limn is active: a line at the head, a recent sighting, a recent reply, or an unreadable head', async () => {
    // His `limn/review-*` line at the head (live).
    lines = [{ login: 'robin-dev' }];
    let p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(postReview.mock.calls.at(-1)![0].verdict).toBe('APPROVE');
    // Seen an hour ago (his review was posted at 10:00).
    lines = [];
    now = Date.parse('2026-11-03T11:00:00Z');
    p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(liveTeamLines).toHaveBeenCalledTimes(1); // the DB pre-check held it before any line read
    // A thread reply of his on GitHub an hour ago.
    now = DAY_LATER;
    p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    live.list = [...live.list, { id: 88, login: 'robin-dev', state: 'COMMENTED', body: 'Still looking.', submittedAt: '2026-11-04T09:00:00Z' }];
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    // His block was posted at the head itself: his Limn has reviewed this commit.
    p = await blockedPr({ consent: false });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    // The head's lines could not be read.
    lines = null;
    p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(p.teammateId)).toBeNull();
  });

  it('never a person’s review: no Limn marker on GitHub, never dismissed', async () => {
    const { prId, findings, ghId } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    live.list = [{ id: ghId, login: 'robin-dev', state: 'CHANGES_REQUESTED', body: 'Please fix the lock first.' }];
    await goAway(prId, await approveRun(prId, findings));
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('gated like the verdict: auto verdict off, an impact the reader does not approve, or their own PR', async () => {
    await setPost({ liftTeammateBlocks: false, autoVerdict: false });
    let p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    await setPost({ liftTeammateBlocks: false, autoVerdict: true, approveImpact: { high: false, medium: false, low: false } });
    p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(postReview.mock.calls.at(-1)![0].verdict).toBe('COMMENT');
    expect(dismissReview).not.toHaveBeenCalled();
    await setPost({ liftTeammateBlocks: false, autoVerdict: true, approveImpact: { high: true, medium: true, low: true } });
    p = await blockedPr({ consent: false, author: ALICE, blockHead: OLD_HEAD });
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('a refused approve went out as a comment: nothing is dismissed', async () => {
    const { prId, teammateId, findings } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    postReview.mockImplementation(async (a: any) => {
      if (a.verdict === 'APPROVE') throw Object.assign(new Error('Review cannot be approved'), { status: 422 });
      return { postedReviewId: 'MYc', inlineFindingIds: [], prComments: [], commentCount: 0, prCommentCount: 0 };
    });
    await goAway(prId, await approveRun(prId, findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toBeNull();
  });

  it('the claim: one already claimed by another run is never dismissed', async () => {
    const { prId, teammateId, findings } = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    expect(await F.lift.claimTeammateLift(F.ctx, 1, teammateId, { byReviewId: 1, headSha: HEAD, points: 2, message: 'm', why: 'away' })).toBe(true);
    await goAway(prId, await approveRun(prId, findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toMatchObject({ status: 'dismissing', byReviewId: 1 });
  });

  it('a review robin sent with the Post button is never dismissed as away', async () => {
    const { prId, teammateId, findings } = await blockedPr({ body: manualSummary() });
    await goAway(prId, await approveRun(prId, findings));
    expect(postReview.mock.calls.at(-1)![0].verdict).toBe('APPROVE');
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(teammateId)).toBeNull();
    // Imported as auto but read live as manual (the live body is the one that counts): still held.
    const p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    live.list = live.list.map((r: any) => (r.login === 'robin-dev' ? { ...r, body: manualSummary() } : r));
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
  });

  it('an earlier blocker of robin’s that the block left out must be settled too', async () => {
    // robin's Limn posted blocker X at an older commit; at OLD_HEAD it re-found X (deduped, not posted
    // again) and posted one warning W with Request changes. The block's own comments hold only W.
    const EARLIER = 'c'.repeat(40);
    const earlierBody = `Fix the lock.\n\n${limnReviewMarker('ee33', { headSha: EARLIER, run: 'auto', verdict: 'REQUEST_CHANGES' })}`;
    const shape = (pr: any): void => {
      const n = pr.number;
      pr.reviews.nodes.unshift({ id: `RV_${n}e`, fullDatabaseId: String(700 + n), state: 'CHANGES_REQUESTED', body: earlierBody, submittedAt: '2026-11-02T10:00:00Z', author: ROBIN });
      pr.comments.nodes = [
        { id: `IC_${n}09`, fullDatabaseId: `${n}09`, body: `**Blocker** · \`src/y.ts:4\`\n\nThe lock is never released.\n\n<!-- pierre:claude-review-finding v=1 -->`, createdAt: '2026-11-02T10:00:10Z', diffHunk: null, author: ROBIN },
      ];
    };
    const p = await blockedPr({ consent: false, blockHead: OLD_HEAD, shape });
    const x = p.allFindings.find((f: any) => f.severity === 'blocker');
    expect(p.findings.map((f: any) => f.severity)).toEqual(['warning']);
    expect(x).toBeDefined();
    // The reader's run is sent X too (it is not in the block's own review).
    const { loadStandingBlockAnchors } = await import('./teammate-anchor.js');
    const anchors = await loadStandingBlockAnchors(F.ctx, p.prId, 1, null, HEAD);
    expect(anchors.flatMap((a) => a.findings.map((f) => f.id)).sort()).toEqual([p.findings[0].id, x.id].sort());
    // Only W judged: X was never checked, so nothing is dismissed.
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(postReview.mock.calls.at(-1)![0].verdict).toBe('APPROVE');
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(p.teammateId)).toBeNull();
    // X not addressed: still nothing.
    await goAway(p.prId, await approveRun(p.prId, p.findings, [...allAddressed(p.findings), { id: x.id, status: 'not_addressed' }]));
    expect(dismissReview).not.toHaveBeenCalled();
    // Both settled at this commit: dismissed, counting both points.
    await goAway(p.prId, await approveRun(p.prId, p.allFindings));
    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(await teammateLiftOf(p.teammateId)).toMatchObject({ status: 'dismissed', why: 'away', points: 2 });
  });

  it('robin active by hand (a PR comment he typed 10 minutes ago, on any PR) is not away', async () => {
    const { eq } = await import('drizzle-orm');
    const p = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    const robin = (await F.db.select({ id: F.schema.users.id }).from(F.schema.users).where(eq(F.schema.users.githubLogin, 'robin-dev')).execute())[0].id;
    const other = await blockedPr({ consent: false, blockHead: OLD_HEAD });
    await F.db
      .insert(F.schema.prComments)
      .values({ githubNodeId: `IC_human_${other.prId}`, prId: other.prId, authorId: robin, body: 'Looking at this now.', createdAt: new Date(now - 10 * 60_000) })
      .execute();
    expect(await F.lift.teammateLastSeenMs(F.ctx, 1, robin, 'robin-dev')).toBe(now - 10 * 60_000);
    await goAway(p.prId, await approveRun(p.prId, p.findings));
    expect(dismissReview).not.toHaveBeenCalled();
    expect(await teammateLiftOf(p.teammateId)).toBeNull();
    await F.db.delete(F.schema.prComments).where(eq(F.schema.prComments.githubNodeId, `IC_human_${other.prId}`)).execute();
  });
});
