// CLAUDE + CODEX, EACH FOLLOWS UP THE OTHER (docs/CLAUDE-REVIEW.md § Claude + Codex, cross-provider
// follow-up) — the pure rules. The DB half (the loader's cross carry, the cover pass end to end, the
// replies pass reading both chains) is in replies-check-pipeline.test.ts and persist.test.ts.
//
//   pnpm --filter @pierre-review/backend test cross-provider-follow-up
import { describe, expect, it } from 'vitest';
import type { ClaudeReview } from '@pierre-review/shared';
import { isCrossDispute, reconcileFollowUp, selectPriorFindings, type PriorFindingForFollowUp } from './follow-up.js';
import { buildUserPrompt } from './prompts.js';
import { coverReports, coverSummary, reconcileReplies, type RepliesPlan } from './replies-pass.js';
import { buildCoverPrompt } from './replies-check-prompt.js';
import { prLevelStillOpenItems, stillOpenCandidates } from './still-open.js';
import { coverTarget } from './pair.js';

const OLD = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
let nextId = 1;
function prior(over: Partial<PriorFindingForFollowUp> = {}): PriorFindingForFollowUp {
  const id = over.id ?? nextId++;
  return {
    id,
    headSha: OLD,
    path: `src/f${id}.ts`,
    line: 10,
    side: 'RIGHT',
    severity: 'warning',
    title: `finding ${id}`,
    body: `body ${id}`,
    suggestion: null,
    diffHunk: null,
    anchored: true,
    fileInDiff: true,
    posted: true,
    carried: false,
    ...over,
  };
}
const reply = { author: 'alice', body: 'It is fine.', at: new Date().toISOString(), fromLimn: false };

describe('selecting the other provider’s findings', () => {
  it('they go after own AND carried ones, whatever their severity', () => {
    const own = prior({ severity: 'nit' });
    const carried = prior({ carried: true, severity: 'nit' });
    const cross = prior({ carried: true, severity: 'blocker', raisedBy: 'codex' });
    const plan = selectPriorFindings({ reviewId: 1, headSha: OLD, findings: [cross, carried, own] }, HEAD);
    expect(plan.sent.map((s) => s.finding.id)).toEqual([own.id, carried.id, cross.id]);
  });

  it('one raised at this very head keeps the other provider’s answer, else not_addressed (decided in code)', () => {
    const fresh = prior({ carried: true, headSha: HEAD, raisedBy: 'codex' });
    const answered = prior({
      carried: true,
      headSha: HEAD,
      raisedBy: 'codex',
      priorStatus: { status: 'reply_disputed', explanation: 'Still there.', how: 'Bound it.' },
    });
    const moved = prior({ carried: true, headSha: OLD, raisedBy: 'codex' });
    const plan = selectPriorFindings({ reviewId: 1, headSha: OLD, findings: [fresh, answered, moved] }, HEAD);
    expect(plan.locked.get(fresh.id)?.status).toBe('not_addressed');
    // A carried dispute locks as plain not_addressed, keeping its words.
    expect(plan.locked.get(answered.id)).toEqual({ status: 'not_addressed', explanation: 'Still there.', how: 'Bound it.' });
    expect(plan.locked.has(moved.id)).toBe(false);
  });
});

describe('never disputing the other provider’s finding', () => {
  it('isCrossDispute: only a reply_disputed on a raisedBy finding', () => {
    expect(isCrossDispute({ raisedBy: 'codex' }, 'reply_disputed')).toBe(true);
    expect(isCrossDispute({ raisedBy: 'codex' }, 'reply_accepted')).toBe(false);
    expect(isCrossDispute({}, 'reply_disputed')).toBe(false);
  });

  it('the review’s follow-up stores a dispute on it as not_addressed with no reply text; addressed stands', () => {
    const disputed = prior({ carried: true, raisedBy: 'codex', thread: { threadId: 5, threadFindingId: 9, replies: [reply], pushedBack: false } });
    const fixed = prior({ carried: true, raisedBy: 'codex', line: null });
    const plan = selectPriorFindings({ reviewId: 1, headSha: OLD, findings: [disputed, fixed] }, HEAD);
    const items = reconcileFollowUp(plan, [
      { ref: 'P1', status: 'reply_disputed', explanation: 'Not bounded.', reply: 'It is not.', how: 'Bound the loop.' },
      { ref: 'P2', status: 'addressed', explanation: 'Handled now.', how: 'Handled first.' },
    ]);
    expect(items.map((i) => [i.status, i.raisedBy, i.reply ?? null, i.response ?? null, i.how ?? null])).toEqual([
      ['not_addressed', 'codex', null, null, 'Bound the loop.'],
      ['addressed', 'codex', null, null, 'Handled first.'],
    ]);
    // Its own finding is disputed as before.
    const own = prior({ thread: { threadId: 6, threadFindingId: 10, replies: [reply], pushedBack: false } });
    const ownPlan = selectPriorFindings({ reviewId: 1, headSha: OLD, findings: [own] }, HEAD);
    expect(reconcileFollowUp(ownPlan, [{ ref: 'P1', status: 'reply_disputed', explanation: 'x', reply: 'No.' }])[0]!.status).toBe('reply_disputed');
  });

  it('a replies pass judging it (its owner’s provider could not run) never disputes it either', () => {
    const f = prior({ raisedBy: 'codex', thread: { threadId: 5, threadFindingId: 9, replies: [reply], pushedBack: false } });
    const plan: RepliesPlan = { headSha: HEAD, sent: [{ ref: 'T1', finding: f, code: null }], omitted: [] };
    const [item] = reconcileReplies(plan, [{ ref: 'T1', status: 'reply_disputed', reply: 'No.', how: 'Bound it.' }]);
    expect(item).toMatchObject({ status: 'not_addressed', raisedBy: 'codex', how: 'Bound it.' });
    expect(item!.reply ?? null).toBeNull();
  });

  it('no still-open comment is planned for it, inline or PR-level', () => {
    const run = {
      threadAssessments: null,
      followUp: {
        priorReviewId: 1,
        priorHeadSha: OLD,
        headMoved: true,
        changesSinceShown: false,
        items: [
          { ref: 'P1', priorFindingId: 1, sent: true, carried: true, status: 'not_addressed', explanation: 'x', path: 'a', line: 1, side: 'RIGHT', severity: 'blocker', title: 't', headMoved: true, priorPosted: true, threadId: 5, threadFindingId: 1, raisedBy: 'codex' },
          { ref: 'P2', priorFindingId: 2, sent: true, carried: true, status: 'not_addressed', explanation: 'y', path: 'b', line: null, side: 'RIGHT', severity: 'warning', title: 'u', headMoved: true, priorPosted: true, prComment: { findingId: 2, commentId: '1', url: null }, raisedBy: 'codex' },
        ],
      },
    } as unknown as Pick<ClaudeReview, 'followUp' | 'threadAssessments'>;
    expect(stillOpenCandidates([run], new Map([[5, { severity: 'blocker' }]]))).toEqual([]);
    expect(prLevelStillOpenItems([run]).size).toBe(0);
  });
});

describe('the prompts', () => {
  const base = {
    repoFullName: 'acme/api',
    prNumber: 1,
    title: 't',
    body: null,
    headSha: HEAD,
    baseRef: 'main',
    changedFiles: ['src/a.ts'],
    excludedFiles: [],
    diff: 'diff',
    nonce: 'NONCE',
  };
  it('the review names who raised it, and the rule appears only when one is shown', () => {
    const cross = selectPriorFindings({ reviewId: 1, headSha: OLD, findings: [prior({ carried: true, raisedBy: 'codex' })] }, HEAD);
    const text = buildUserPrompt({ ...base, followUp: { plan: cross, since: null } });
    expect(text).toContain('(raised by Codex in an earlier review, at head aaaaaaaaaaaa)');
    expect(text).toContain('Findings marked "raised by Codex" come from another reviewer');
    const own = selectPriorFindings({ reviewId: 1, headSha: OLD, findings: [prior()] }, HEAD);
    expect(buildUserPrompt({ ...base, followUp: { plan: own, since: null } })).not.toContain('another reviewer');
  });

  it('the cover pass asks for the code statuses and never a dispute', () => {
    const plan = selectPriorFindings({ reviewId: 1, headSha: OLD, findings: [prior({ carried: true, raisedBy: 'codex' })] }, HEAD);
    const text = buildCoverPrompt({ repoFullName: 'acme/api', number: 1, title: 't', headSha: HEAD, worktreePath: null, plan, code: new Map(), nonce: 'NONCE', provider: 'claude' });
    expect(text).toContain('## Earlier findings to check');
    expect(text).toContain('- addressed: the code now deals with it');
    expect(text).toContain('---BEGIN FINDING P1 NONCE---');
    expect(text).not.toContain('reply_disputed');
  });
});

describe('the cover pass', () => {
  it('coverTarget: the half that succeeded covers the one that failed or never started', () => {
    const base = { firstProvider: 'claude' as const, secondProvider: 'codex' as const };
    expect(coverTarget({ ...base, firstSucceeded: true, secondSucceeded: false })).toEqual({ survivor: 'claude', failed: 'codex' });
    expect(coverTarget({ ...base, firstSucceeded: false, secondSucceeded: true })).toEqual({ survivor: 'codex', failed: 'claude' });
    expect(coverTarget({ ...base, firstSucceeded: true, secondSucceeded: null, notStarted: 'error' })).toEqual({ survivor: 'claude', failed: 'codex' });
    expect(coverTarget({ ...base, firstSucceeded: true, secondSucceeded: null, notStarted: 'budget' })).toEqual({ survivor: 'claude', failed: 'codex' });
    // Both succeeded, both failed, the reader stopped it, a teammate's Limn holds the other half: none.
    expect(coverTarget({ ...base, firstSucceeded: true, secondSucceeded: true })).toBeNull();
    expect(coverTarget({ ...base, firstSucceeded: false, secondSucceeded: false })).toBeNull();
    expect(coverTarget({ ...base, firstSucceeded: true, secondSucceeded: false, stopped: true })).toBeNull();
    expect(coverTarget({ ...base, firstSucceeded: true, secondSucceeded: null, notStarted: 'claimed' })).toBeNull();
    expect(coverTarget({ ...base, firstSucceeded: true, secondSucceeded: null, notStarted: 'stopped' })).toBeNull();
  });

  it('coverReports keeps the code statuses for the review’s gate', () => {
    expect(coverReports([{ ref: 'P1', status: 'addressed', explanation: 'x', how: 'y' }, { ref: 2 } as never])).toEqual([
      { ref: 'P1', status: 'addressed', explanation: 'x', how: 'y', acceptKind: null, reply: null, replyRef: null },
    ]);
  });

  it('coverSummary names whose findings it checked', () => {
    expect(coverSummary([{ status: 'addressed' }, { status: 'not_addressed' }, { status: 'not_checked' }], 'codex')).toBe(
      "Checked Codex's 3 open findings: 1 dealt with, 1 still open, 1 not checked.",
    );
    expect(coverSummary([{ status: 'reply_accepted' }], 'claude')).toBe("Checked Claude's 1 open finding: 1 dealt with.");
  });
});
