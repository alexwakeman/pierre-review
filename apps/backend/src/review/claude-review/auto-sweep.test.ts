// THE AUTO-REVIEW SWEEPER (claude-review/auto.ts) — which PRs it hands the lane, and when it does
// nothing at all. The population rules (open, not draft, opened after the switch-on, a person, no
// run yet) are CORE's and are pinned in apps/backend/src/db/my-turn-claude-review.test.ts; this file
// pins what the sweeper adds on top:
//
//   1. the FLOOR it asks with is the workspace's own `enabledAt`, and the day is the UTC day;
//   2. ⚠ THE DAILY CAP counts runs already started today PLUS items still waiting in the lane;
//   3. an account whose credits are spent sits the tick out (and its candidates are never read);
//   4. ⚠ IT NEVER RUNS IN CLOUD, or on a host without the seam;
//   5. a full lane stops the tick — the rest wait, since the database is the queue;
//   6. ⚠ while AI is not set up (no runtime / no credential) it queues NOTHING, so no PR gets a
//      failed row that would use up its one automatic review;
//   7. ⚠ a RE-REVIEW of a moved head is DEBOUNCED: queued once the head has held still for
//      AUTO_REREVIEW_SETTLE_MS, once per head, and a burst of pushes costs one run.
//
//   pnpm --filter @pierre-review/backend test claude-review/auto-sweep
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext as ProContext } from '../agent-context.js';

const enqueued: Array<[number, number]> = [];
// The comment time each queued re-review carried (manager.ts settle re-check), in queue order.
const enqueuedCommentsAt: Array<number | null | undefined> = [];
let laneRoom = 20;
let waiting = new Set<number>();
let enqueueAnswer: (prId: number) => string = () => 'queued';
let dropKeep: ((accountId: number, workspaceId: number) => boolean) | null = null;
vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  dropAutoReviews: (keep: (accountId: number, workspaceId: number) => boolean) => {
    dropKeep = keep;
    return 0;
  },
  autoLaneRoom: () => laneRoom,
  autoPendingPrIds: () => waiting,
  enqueueAutoReview: (
    _ctx: unknown,
    accountId: number,
    prId: number,
    _workspaceId?: number,
    commentsAtMs?: number | null,
  ) => {
    const r = enqueueAnswer(prId);
    if (r === 'queued') {
      enqueued.push([accountId, prId]);
      enqueuedCommentsAt.push(commentsAtMs);
      laneRoom -= 1;
    }
    return r;
  },
}));

let aiReady = true;
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => aiReady }));

let roster: Array<{ accountId: number; workspaceId: number; enabledAtMs: number }> = [];
vi.mock('./auto-settings.js', () => ({
  AUTO_REVIEW_DAILY_CAP: 20,
  listAutoReviewWorkspaces: async () => roster,
}));

const {
  runAutoReviewSweep,
  utcDayStartMs,
  AUTO_REREVIEW_SETTLE_MS,
  AUTO_REREVIEW_MAX_WAIT_MS,
  AUTO_REVIEW_CI_WAIT_MS,
  autoReviewDue,
  autoReviewWaiting,
  _resetAutoReReviewForTest,
} = await import('./auto.js');

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const ids = (n: number, from = 1): number[] => Array.from({ length: n }, (_, i) => from + i);

/* eslint-disable @typescript-eslint/no-explicit-any */
let calls: any[];
let answers: Map<
  number,
  {
    prIds: number[];
    autoToday: number;
    reReview?: Array<{ prId: number; headSha: string; commentsAtMs?: number | null }>;
    ci?: Array<{ prId: number; headSha: string | null; running: boolean; headSeenAtMs: number | null }>;
  }
>;
let blocked: Set<number>;
const makeCtx = (over: Record<string, unknown> = {}): ProContext =>
  ({
    host: { isCloud: false },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    aiCredits: { check: async (a: number) => ({ agentBlocked: blocked.has(a) }) },
    queries: {
      getAutoReviewCandidates: async (accountId: number, workspaceId: number, opts: any) => {
        calls.push({ accountId, workspaceId, ...opts });
        return answers.get(workspaceId) ?? null;
      },
    },
    ...over,
  }) as any as ProContext;

beforeEach(() => {
  enqueued.length = 0;
  enqueuedCommentsAt.length = 0;
  laneRoom = 20;
  waiting = new Set();
  enqueueAnswer = () => 'queued';
  dropKeep = null;
  aiReady = true;
  calls = [];
  answers = new Map();
  blocked = new Set();
  roster = [{ accountId: 1, workspaceId: 7, enabledAtMs: NOW - 3_600_000 }];
  _resetAutoReReviewForTest();
});

describe('runAutoReviewSweep', () => {
  it('asks with the workspace’s own switch-on moment and the UTC day start', async () => {
    answers.set(7, { prIds: [11, 12], autoToday: 0 });
    const r = await runAutoReviewSweep(makeCtx(), NOW);
    expect(calls[0]).toMatchObject({
      accountId: 1,
      workspaceId: 7,
      openedSinceMs: NOW - 3_600_000,
      dayStartMs: Date.UTC(2026, 8, 30),
    });
    expect(utcDayStartMs(NOW)).toBe(Date.UTC(2026, 8, 30));
    expect(enqueued).toEqual([
      [1, 11],
      [1, 12],
    ]);
    expect(r.queued).toBe(2);
  });

  it('⚠ stops at the daily cap, counting today’s runs AND waiting items', async () => {
    // 17 started today, PR 1 already waiting in the lane ⇒ room for 2 more, not 3.
    waiting = new Set([1]);
    answers.set(7, { prIds: ids(10), autoToday: 17 });
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued.map(([, p]) => p)).toEqual([2, 3]);
  });

  it('enqueues nothing once the cap is reached — those PRs wait for tomorrow', async () => {
    answers.set(7, { prIds: ids(5), autoToday: 20 });
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued).toEqual([]);
  });

  it('skips an account whose credits are spent, without reading its candidates', async () => {
    roster = [
      { accountId: 1, workspaceId: 7, enabledAtMs: 0 },
      { accountId: 2, workspaceId: 8, enabledAtMs: 0 },
    ];
    blocked = new Set([1]);
    answers.set(7, { prIds: [1], autoToday: 0 });
    answers.set(8, { prIds: [2], autoToday: 0 });
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(calls.map((c) => c.workspaceId)).toEqual([8]);
    expect(enqueued).toEqual([[2, 2]]);
  });

  it('a full lane stops the tick', async () => {
    laneRoom = 1;
    roster = [
      { accountId: 1, workspaceId: 7, enabledAtMs: 0 },
      { accountId: 1, workspaceId: 9, enabledAtMs: 0 },
    ];
    answers.set(7, { prIds: [1, 2, 3], autoToday: 0 });
    answers.set(9, { prIds: [4], autoToday: 0 });
    enqueueAnswer = () => (laneRoom > 0 ? 'queued' : 'full');
    const r = await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued.map(([, p]) => p)).toEqual([1]);
    expect(r.stopped).toBe('lane_full');
    expect(calls.map((c) => c.workspaceId)).toEqual([7]);
  });

  it('a PR a person already started does not use up the day', async () => {
    answers.set(7, { prIds: [1, 2, 3], autoToday: 19 });
    enqueueAnswer = (p) => (p === 1 ? 'already' : 'queued');
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued.map(([, p]) => p)).toEqual([2]);
  });

  it('⚠ does nothing in cloud', async () => {
    answers.set(7, { prIds: [1], autoToday: 0 });
    await runAutoReviewSweep(makeCtx({ host: { isCloud: true } }), NOW);
    expect(calls).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('⚠ queues nothing while AI is not set up — those PRs still qualify later', async () => {
    answers.set(7, { prIds: [1, 2], autoToday: 0 });
    aiReady = false;
    const r = await runAutoReviewSweep(makeCtx(), NOW);
    expect(r.stopped).toBe('ai_not_ready');
    expect(calls).toEqual([]);
    expect(enqueued).toEqual([]);
    aiReady = true;
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued.map(([, p]) => p)).toEqual([1, 2]);
  });

  it('does nothing on a host without the seam', async () => {
    await runAutoReviewSweep(makeCtx({ queries: {} }), NOW);
    expect(enqueued).toEqual([]);
  });

  it('⚠ drops waiting items of a workspace switched off since they were queued', async () => {
    roster = [{ accountId: 1, workspaceId: 7, enabledAtMs: 0 }];
    answers.set(7, { prIds: [], autoToday: 0 });
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(dropKeep).not.toBeNull();
    expect(dropKeep!(1, 7)).toBe(true); // still on: kept
    expect(dropKeep!(1, 8)).toBe(false); // switched off: dropped
    expect(dropKeep!(2, 7)).toBe(false); // another account's workspace 7 is not this one
  });

  it('skips a workspace that is gone (null) and carries on', async () => {
    roster = [
      { accountId: 1, workspaceId: 404, enabledAtMs: 0 },
      { accountId: 1, workspaceId: 7, enabledAtMs: 0 },
    ];
    answers.set(7, { prIds: [5], autoToday: 0 });
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued).toEqual([[1, 5]]);
  });
});

describe('runAutoReviewSweep — re-review on a moved head', () => {
  const SETTLE = AUTO_REREVIEW_SETTLE_MS;
  const moved = (sha: string) => answers.set(7, { prIds: [], autoToday: 0, reReview: [{ prId: 30, headSha: sha }] });

  it('a new head is queued ONCE, after it has held still for the settle time', async () => {
    moved('b1');
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued).toEqual([]); // first sight starts the wait
    await runAutoReviewSweep(makeCtx(), NOW + SETTLE - 1);
    expect(enqueued).toEqual([]);
    const r = await runAutoReviewSweep(makeCtx(), NOW + SETTLE);
    expect(enqueued).toEqual([[1, 30]]);
    expect(r.reQueued).toBe(1);
    // Once a run exists at that head the candidate read stops offering it.
    answers.set(7, { prIds: [], autoToday: 1, reReview: [] });
    await runAutoReviewSweep(makeCtx(), NOW + 2 * SETTLE);
    expect(enqueued).toEqual([[1, 30]]);
  });

  it('the same head with no new commits is never offered — nothing queued', async () => {
    answers.set(7, { prIds: [], autoToday: 0, reReview: [] });
    await runAutoReviewSweep(makeCtx(), NOW);
    await runAutoReviewSweep(makeCtx(), NOW + 10 * SETTLE);
    expect(enqueued).toEqual([]);
  });

  it('⚠ a burst of pushes restarts the wait each time and costs ONE run, on the last head', async () => {
    moved('c1');
    await runAutoReviewSweep(makeCtx(), NOW);
    moved('c2');
    await runAutoReviewSweep(makeCtx(), NOW + SETTLE - 1000);
    moved('c3');
    await runAutoReviewSweep(makeCtx(), NOW + 2 * SETTLE - 2000);
    expect(enqueued).toEqual([]);
    await runAutoReviewSweep(makeCtx(), NOW + 3 * SETTLE);
    expect(enqueued).toEqual([[1, 30]]);
  });

  it('⚠ auto review off for the workspace ⇒ no re-review', async () => {
    moved('d1');
    await runAutoReviewSweep(makeCtx(), NOW);
    roster = [];
    await runAutoReviewSweep(makeCtx(), NOW + 2 * SETTLE);
    expect(enqueued).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('a re-review waiting in the lane is not queued twice, and counts against the day', async () => {
    moved('e1');
    await runAutoReviewSweep(makeCtx(), NOW);
    waiting = new Set([30]);
    await runAutoReviewSweep(makeCtx(), NOW + SETTLE);
    expect(enqueued).toEqual([]);
  });

  it('the daily cap applies to re-reviews too', async () => {
    answers.set(7, { prIds: [], autoToday: 20, reReview: [{ prId: 30, headSha: 'f1' }] });
    await runAutoReviewSweep(makeCtx(), NOW);
    await runAutoReviewSweep(makeCtx(), NOW + SETTLE);
    expect(enqueued).toEqual([]);
  });
});

// RE-REVIEW ON NEW REVIEW COMMENTS: the candidate read offers an unchanged head with the newest
// qualifying comment's time (core pins WHICH comments qualify — Limn's own never do — in
// claude-review/threads-db.test.ts); the sweeper debounces on (head, comment time).
describe('runAutoReviewSweep — re-review on new review comments', () => {
  const SETTLE = AUTO_REREVIEW_SETTLE_MS;
  const C1 = NOW - 60_000;
  const commented = (commentsAtMs: number, headSha = 'h1') =>
    answers.set(7, { prIds: [], autoToday: 0, reReview: [{ prId: 40, headSha, commentsAtMs }] });

  it('a new comment is queued ONCE, after the settle time, carrying its comment time', async () => {
    commented(C1);
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued).toEqual([]);
    await runAutoReviewSweep(makeCtx(), NOW + SETTLE - 1);
    expect(enqueued).toEqual([]);
    const r = await runAutoReviewSweep(makeCtx(), NOW + SETTLE);
    expect(enqueued).toEqual([[1, 40]]);
    expect(enqueuedCommentsAt).toEqual([C1]);
    expect(r.reQueued).toBe(1);
    // The run covered that comment: the read stops offering it.
    answers.set(7, { prIds: [], autoToday: 1, reReview: [] });
    await runAutoReviewSweep(makeCtx(), NOW + 3 * SETTLE);
    expect(enqueued).toEqual([[1, 40]]);
  });

  it('⚠ a burst of comments restarts the wait each time and costs ONE run', async () => {
    commented(C1);
    await runAutoReviewSweep(makeCtx(), NOW);
    commented(C1 + 1_000);
    await runAutoReviewSweep(makeCtx(), NOW + SETTLE - 1000);
    commented(C1 + 2_000);
    await runAutoReviewSweep(makeCtx(), NOW + 2 * SETTLE - 2000);
    expect(enqueued).toEqual([]);
    await runAutoReviewSweep(makeCtx(), NOW + 3 * SETTLE);
    expect(enqueued).toEqual([[1, 40]]);
    expect(enqueuedCommentsAt).toEqual([C1 + 2_000]);
  });

  it('a push after a comment restarts the wait too (the key is head AND comment time)', async () => {
    commented(C1, 'h1');
    await runAutoReviewSweep(makeCtx(), NOW);
    answers.set(7, { prIds: [], autoToday: 0, reReview: [{ prId: 40, headSha: 'h2', commentsAtMs: null }] });
    await runAutoReviewSweep(makeCtx(), NOW + SETTLE);
    expect(enqueued).toEqual([]);
    await runAutoReviewSweep(makeCtx(), NOW + 2 * SETTLE);
    expect(enqueued).toEqual([[1, 40]]);
    expect(enqueuedCommentsAt).toEqual([null]);
  });

  it('⚠ auto review off ⇒ no comment-triggered re-review', async () => {
    commented(C1);
    await runAutoReviewSweep(makeCtx(), NOW);
    roster = [];
    await runAutoReviewSweep(makeCtx(), NOW + 2 * SETTLE);
    expect(enqueued).toEqual([]);
  });

  it('respects the daily cap', async () => {
    answers.set(7, { prIds: [], autoToday: 20, reReview: [{ prId: 40, headSha: 'h1', commentsAtMs: C1 }] });
    await runAutoReviewSweep(makeCtx(), NOW);
    await runAutoReviewSweep(makeCtx(), NOW + SETTLE);
    expect(enqueued).toEqual([]);
  });
});

// THE START RULE: start ⇔ (quiet ≥ 5 min OR burst ≥ 20 min) AND (CI not running OR head age ≥ 30 min).
describe('autoReviewDue — the one start rule', () => {
  const MIN = 60_000;
  const T = 1_000_000_000;
  const settle = (quietMin: number, burstMin: number, reason: 'head' | 'comments' = 'comments') => ({
    quietSinceMs: T - quietMin * MIN,
    burstStartMs: T - burstMin * MIN,
    reason,
  });
  it('waits for quiet, says which kind of activity', () => {
    expect(autoReviewDue({ nowMs: T, settle: settle(4, 4), ciRunning: false, headSeenMs: T - 99 * MIN })).toEqual({
      due: false,
      reason: 'comments',
    });
    expect(autoReviewDue({ nowMs: T, settle: settle(4, 4, 'head'), ciRunning: false, headSeenMs: T })).toEqual({
      due: false,
      reason: 'commits',
    });
    expect(autoReviewDue({ nowMs: T, settle: settle(5, 5), ciRunning: false, headSeenMs: T }).due).toBe(true);
  });
  it('⚠ the 20-minute ceiling beats a quiet clock that keeps restarting', () => {
    expect(autoReviewDue({ nowMs: T, settle: settle(1, 19), ciRunning: false, headSeenMs: T }).due).toBe(false);
    expect(autoReviewDue({ nowMs: T, settle: settle(1, 20), ciRunning: false, headSeenMs: T }).due).toBe(true);
  });
  it('holds for running CI until the head is 30 minutes old — settled or not, CI is checked after', () => {
    expect(autoReviewDue({ nowMs: T, settle: settle(6, 6), ciRunning: true, headSeenMs: T - 29 * MIN })).toEqual({
      due: false,
      reason: 'ci',
    });
    expect(autoReviewDue({ nowMs: T, settle: settle(6, 6), ciRunning: true, headSeenMs: T - 30 * MIN }).due).toBe(true);
    // A first review (no settle) waits on CI alone.
    expect(autoReviewDue({ nowMs: T, settle: null, ciRunning: true, headSeenMs: T })).toEqual({ due: false, reason: 'ci' });
    expect(autoReviewDue({ nowMs: T, settle: null, ciRunning: false, headSeenMs: T }).due).toBe(true);
  });
});

describe('runAutoReviewSweep — WAIT FOR CI', () => {
  const SETTLE = AUTO_REREVIEW_SETTLE_MS;
  const CI_WAIT = AUTO_REVIEW_CI_WAIT_MS;

  it('a first review waits while its head’s CI runs, then starts when CI finishes', async () => {
    answers.set(7, { prIds: [50], autoToday: 0, ci: [{ prId: 50, headSha: 'a', running: true, headSeenAtMs: NOW }] });
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued).toEqual([]);
    expect(autoReviewWaiting(50, 1)).toBe('ci');
    expect(autoReviewWaiting(50, 2)).toBeNull(); // another account never sees it
    answers.set(7, { prIds: [50], autoToday: 0, ci: [{ prId: 50, headSha: 'a', running: false, headSeenAtMs: NOW }] });
    await runAutoReviewSweep(makeCtx(), NOW + 60_000);
    expect(enqueued).toEqual([[1, 50]]);
    expect(autoReviewWaiting(50, 1)).toBeNull();
  });

  it('⚠ gives up waiting 30 minutes after the head was first seen, and reviews anyway', async () => {
    answers.set(7, { prIds: [51], autoToday: 0, ci: [{ prId: 51, headSha: 'a', running: true, headSeenAtMs: null }] });
    await runAutoReviewSweep(makeCtx(), NOW);
    await runAutoReviewSweep(makeCtx(), NOW + CI_WAIT - 1);
    expect(enqueued).toEqual([]);
    await runAutoReviewSweep(makeCtx(), NOW + CI_WAIT);
    expect(enqueued).toEqual([[1, 51]]);
  });

  it('the head’s first observation in the DB starts the 30 minutes, not first sight here', async () => {
    answers.set(7, {
      prIds: [52],
      autoToday: 0,
      ci: [{ prId: 52, headSha: 'a', running: true, headSeenAtMs: NOW - CI_WAIT }],
    });
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued).toEqual([[1, 52]]);
  });

  it('a re-review that has settled still waits for CI, and says so', async () => {
    const reReview = [{ prId: 53, headSha: 'h', commentsAtMs: null }];
    answers.set(7, { prIds: [], autoToday: 0, reReview, ci: [{ prId: 53, headSha: 'h', running: true, headSeenAtMs: null }] });
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(autoReviewWaiting(53, 1)).toBe('commits');
    await runAutoReviewSweep(makeCtx(), NOW + SETTLE);
    expect(enqueued).toEqual([]);
    expect(autoReviewWaiting(53, 1)).toBe('ci');
    await runAutoReviewSweep(makeCtx(), NOW + CI_WAIT);
    expect(enqueued).toEqual([[1, 53]]);
  });

  it('a new head restarts the CI clock (first sight of THAT head)', async () => {
    const at = (headSha: string) =>
      answers.set(7, { prIds: [54], autoToday: 0, ci: [{ prId: 54, headSha, running: true, headSeenAtMs: null }] });
    at('a');
    await runAutoReviewSweep(makeCtx(), NOW);
    at('b');
    await runAutoReviewSweep(makeCtx(), NOW + CI_WAIT - 60_000);
    await runAutoReviewSweep(makeCtx(), NOW + CI_WAIT);
    expect(enqueued).toEqual([]);
    await runAutoReviewSweep(makeCtx(), NOW + 2 * CI_WAIT - 60_000);
    expect(enqueued).toEqual([[1, 54]]);
  });
});

describe('runAutoReviewSweep — the 20-minute ceiling', () => {
  const MAX = AUTO_REREVIEW_MAX_WAIT_MS;

  it('⚠ comments every 4 minutes cannot hold a run back more than 20 minutes from the first', async () => {
    let t = NOW;
    let c = NOW - 1000;
    while (t < NOW + MAX) {
      answers.set(7, { prIds: [], autoToday: 0, reReview: [{ prId: 60, headSha: 'h', commentsAtMs: c }] });
      await runAutoReviewSweep(makeCtx(), t);
      expect(enqueued).toEqual([]);
      expect(autoReviewWaiting(60, 1)).toBe('comments');
      t += 4 * 60_000;
      c += 4 * 60_000;
    }
    answers.set(7, { prIds: [], autoToday: 0, reReview: [{ prId: 60, headSha: 'h', commentsAtMs: c }] });
    await runAutoReviewSweep(makeCtx(), NOW + MAX);
    expect(enqueued).toEqual([[1, 60]]);
    expect(enqueuedCommentsAt).toEqual([c]);
  });

  it('⚠ a burst ends when its run is queued — a comment during that run gets the full quiet wait', async () => {
    answers.set(7, { prIds: [], autoToday: 0, reReview: [{ prId: 62, headSha: 'h', commentsAtMs: 1 }] });
    await runAutoReviewSweep(makeCtx(), NOW);
    await runAutoReviewSweep(makeCtx(), NOW + AUTO_REREVIEW_SETTLE_MS);
    expect(enqueued).toEqual([[1, 62]]);
    // The PR is a candidate again on the very next full pass (a comment landed mid-run), so no
    // prune ever forgot the old burst — its start must not carry over.
    answers.set(7, { prIds: [], autoToday: 0, reReview: [{ prId: 62, headSha: 'h', commentsAtMs: 2 }] });
    await runAutoReviewSweep(makeCtx(), NOW + MAX + 1);
    expect(enqueued).toEqual([[1, 62]]);
    expect(autoReviewWaiting(62, 1)).toBe('comments');
  });

  it('a burst ends when the PR stops being a candidate; the next trigger opens a new one', async () => {
    answers.set(7, { prIds: [], autoToday: 0, reReview: [{ prId: 61, headSha: 'h', commentsAtMs: 1 }] });
    await runAutoReviewSweep(makeCtx(), NOW);
    answers.set(7, { prIds: [], autoToday: 0, reReview: [] });
    await runAutoReviewSweep(makeCtx(), NOW + MAX);
    answers.set(7, { prIds: [], autoToday: 0, reReview: [{ prId: 61, headSha: 'h', commentsAtMs: 2 }] });
    await runAutoReviewSweep(makeCtx(), NOW + MAX + 1);
    expect(enqueued).toEqual([]); // a fresh burst: the 5-minute quiet applies again
  });
});
