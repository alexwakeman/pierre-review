// A TEAMMATE'S VERDICT FIRST + CATCH-UP ON RETURN (claude-review/auto.ts; docs/TEAM-REVIEW.md § 4,
// docs/CLAUDE-REVIEW.md § Auto review). What the sweeper does with the candidate read's `verdictNeeded`
// (the fold itself is pinned in db/teammate-verdict-pickup.test.ts), and how it waits for the first
// sync after a boot, a wake or a long gap.
//
//   pnpm --filter @pierre-review/backend test claude-review/auto-verdict-pickup
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

interface Queued {
  accountId: number;
  prId: number;
  opts?: { pressed?: boolean; priority?: boolean; why?: { reason: string; authorUserId: number; authorVerdict: string | null } };
}
const enqueued: Queued[] = [];
let waiting = new Set<number>();
vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  dropAutoReviews: () => 0,
  autoLaneRoom: () => 20,
  autoPendingPrIds: () => waiting,
  enqueueAutoReview: (_ctx: unknown, accountId: number, prId: number, _ws?: number, _c?: number | null, opts?: Queued['opts']) => {
    enqueued.push({ accountId, prId, ...(opts ? { opts } : {}) });
    return 'queued';
  },
}));

const skipPosts: Array<{ prId: number; headSha: string | null | undefined; reasons: string[] }> = [];
vi.mock('./team-claim-skip.js', () => ({
  postAutoSkipLines: async (_ctx: unknown, a: { prId: number; headSha?: string | null }, skips: Array<{ reason: string }>) => {
    skipPosts.push({ prId: a.prId, headSha: a.headSha, reasons: skips.map((s) => s.reason) });
    return skips.map(() => 'posted');
  },
  autoProvidersForPr: async () => ['claude'],
}));
let aiReady = true;
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => aiReady }));
let roster: Array<{ accountId: number; workspaceId: number; enabledAtMs: number; dailyCap: number }> = [];
vi.mock('./auto-settings.js', () => ({ listAutoReviewWorkspaces: async () => roster }));

const {
  runAutoReviewSweep,
  catchUpOpensAt,
  _resetAutoReReviewForTest,
  _setAutoProviderForTest,
  AUTO_CATCH_UP_GAP_MS,
  AUTO_CATCH_UP_SYNC_WAIT_MAX_MS,
  VERDICT_PICKUP_PER_TICK,
} = await import('./auto.js');

const NOW = Date.UTC(2026, 10, 10, 9, 0);
const ALEX = 2;

type Answer = {
  prIds: number[];
  autoToday: number;
  reReview?: Array<{ prId: number; headSha: string; commentsAtMs?: number | null; lastRunAtMs?: number | null }>;
  verdictNeeded?: Array<{
    prId: number;
    headSha: string;
    reason: 'author_review' | 'moved';
    authorVerdict: 'APPROVE' | 'REQUEST_CHANGES' | null;
    authorUserId: number;
    waitingSinceMs: number;
    lastRunAtMs: number | null;
  }>;
};
let answer: Answer;
let fresh: (sinceMs: number) => boolean;
const freshAsks: number[] = [];

const makeCtx = (over: Record<string, unknown> = {}): AgentContext =>
  ({
    host: {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    queries: {
      getAutoReviewCandidates: async () => answer,
      workspaceHeadsFreshSince: async (_a: number, _w: number, sinceMs: number) => {
        freshAsks.push(sinceMs);
        return fresh(sinceMs);
      },
    },
    ...over,
  }) as unknown as AgentContext;

const owed = (prId: number, authorVerdict: 'APPROVE' | null = 'APPROVE', reason: 'author_review' | 'moved' = 'author_review') => ({
  prId,
  headSha: `h${prId}`,
  reason,
  authorVerdict,
  authorUserId: ALEX,
  waitingSinceMs: NOW - 3_600_000,
  lastRunAtMs: null,
});

beforeEach(() => {
  enqueued.length = 0;
  skipPosts.length = 0;
  freshAsks.length = 0;
  waiting = new Set();
  roster = [{ accountId: 1, workspaceId: 7, enabledAtMs: NOW - 86_400_000, dailyCap: 20 }];
  answer = { prIds: [], autoToday: 0 };
  fresh = () => true;
  aiReady = true;
  _resetAutoReReviewForTest();
  _setAutoProviderForTest(() => 'claude');
});

describe("a teammate's verdict first", () => {
  it("queues an author's own-Limn APPROVE ahead of first reviews, marked priority, with why", async () => {
    answer = { prIds: [21, 22], autoToday: 0, verdictNeeded: [owed(30)] };
    const r = await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued.map((q) => q.prId)).toEqual([30, 21, 22]);
    expect(enqueued[0]!.opts).toMatchObject({
      priority: true,
      why: { reason: 'author_review', authorUserId: ALEX, authorVerdict: 'APPROVE' },
    });
    expect(enqueued[1]!.opts?.priority).toBeUndefined();
    expect(r).toMatchObject({ queued: 3, verdictPickups: 1 });
  });

  it('is not exempt from the daily cap: the cap is spent on it first, and a capped one is said on the PR', async () => {
    answer = { prIds: [21], autoToday: 19, verdictNeeded: [owed(30), owed(31)] };
    const r = await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued.map((q) => q.prId)).toEqual([30]);
    expect(r.capped).toBe(true);
    expect(skipPosts).toEqual(
      expect.arrayContaining([
        { prId: 31, headSha: 'h31', reasons: ['daily_cap'] },
        { prId: 21, headSha: null, reasons: ['daily_cap'] },
      ]),
    );
  });

  it(`queues at most ${VERDICT_PICKUP_PER_TICK} a tick; the rest wait for the next tick`, async () => {
    answer = { prIds: [], autoToday: 0, verdictNeeded: Array.from({ length: VERDICT_PICKUP_PER_TICK + 2 }, (_, i) => owed(40 + i)) };
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued).toHaveLength(VERDICT_PICKUP_PER_TICK);
    enqueued.length = 0;
    answer.verdictNeeded = answer.verdictNeeded!.slice(VERDICT_PICKUP_PER_TICK);
    await runAutoReviewSweep(makeCtx(), NOW + 60_000);
    expect(enqueued.map((q) => q.prId)).toEqual([40 + VERDICT_PICKUP_PER_TICK, 41 + VERDICT_PICKUP_PER_TICK]);
  });

  it('a moved head on the list is never queued twice by the ordinary re-review loop', async () => {
    answer = {
      prIds: [],
      autoToday: 0,
      verdictNeeded: [owed(30, null, 'moved')],
      reReview: [{ prId: 30, headSha: 'h30', commentsAtMs: null, lastRunAtMs: NOW - 86_400_000 }],
    };
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued.map((q) => q.prId)).toEqual([30]);
  });

  it('a queued pick-up still waiting in the lane counts against the daily cap', async () => {
    // #30 was queued on an earlier tick and has not started: no row yet, so `autoToday` misses it.
    waiting = new Set([30]);
    answer = { prIds: [], autoToday: 18, verdictNeeded: [owed(30), owed(31), owed(32)] };
    const r = await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued.map((q) => q.prId)).toEqual([31]);
    expect(r.capped).toBe(true);
    expect(skipPosts).toEqual([{ prId: 32, headSha: 'h32', reasons: ['daily_cap'] }]);
  });

  it('a PR already waiting in the lane is not queued again', async () => {
    waiting = new Set([30]);
    answer = { prIds: [], autoToday: 0, verdictNeeded: [owed(30)] };
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued).toEqual([]);
  });

  it('over the spend budget: skipped, never queued, and said on the PR', async () => {
    answer = { prIds: [], autoToday: 0, verdictNeeded: [owed(30)] };
    const r = await runAutoReviewSweep(makeCtx({ aiBudget: { allowAutomaticRun: async () => false } }), NOW);
    expect(enqueued).toEqual([]);
    expect(r.overBudget).toBe(true);
    expect(skipPosts).toEqual([{ prId: 30, headSha: 'h30', reasons: ['budget'] }]);
  });
});

describe('catch-up on return', () => {
  it('opens on the first tick (a boot) and after a long gap, never on an ordinary minute', () => {
    expect(catchUpOpensAt(null, NOW)).toBe(NOW);
    expect(catchUpOpensAt(NOW - 60_000, NOW)).toBeNull();
    expect(catchUpOpensAt(NOW - AUTO_CATCH_UP_GAP_MS, NOW)).toBe(NOW);
  });

  it('waits for the first sync after a boot, then queues the owed verdicts', async () => {
    answer = { prIds: [21], autoToday: 0, verdictNeeded: [owed(30, null, 'moved')] };
    fresh = () => false;
    const held = await runAutoReviewSweep(makeCtx(), NOW);
    expect(held.syncWait).toBe(true);
    expect(enqueued).toEqual([]);
    expect(freshAsks).toEqual([NOW]);
    fresh = () => true;
    const next = await runAutoReviewSweep(makeCtx(), NOW + 60_000);
    expect(next.syncWait).toBeUndefined();
    expect(enqueued.map((q) => q.prId)).toEqual([30, 21]);
    // Once fresh, the workspace is not asked again until the next gap.
    await runAutoReviewSweep(makeCtx(), NOW + 120_000);
    expect(freshAsks).toEqual([NOW, NOW]);
  });

  it('after days away, waits for heads checked SINCE the return, not before', async () => {
    await runAutoReviewSweep(makeCtx(), NOW); // the boot's catch-up, fresh at once
    const back = NOW + 3 * 86_400_000;
    answer = { prIds: [], autoToday: 0, verdictNeeded: [owed(30)] };
    // Heads checked before the return are stale.
    fresh = (sinceMs) => sinceMs <= NOW;
    expect((await runAutoReviewSweep(makeCtx(), back)).syncWait).toBe(true);
    expect(freshAsks.at(-1)).toBe(back);
    expect(enqueued).toEqual([]);
    fresh = () => true;
    await runAutoReviewSweep(makeCtx(), back + 60_000);
    expect(enqueued.map((q) => q.prId)).toEqual([30]);
  });

  it('never waits longer than the ceiling', async () => {
    answer = { prIds: [21], autoToday: 0 };
    fresh = () => false;
    await runAutoReviewSweep(makeCtx(), NOW);
    for (let t = NOW + 60_000; t < NOW + AUTO_CATCH_UP_SYNC_WAIT_MAX_MS; t += 4 * 60_000) await runAutoReviewSweep(makeCtx(), t);
    expect(enqueued).toEqual([]);
    await runAutoReviewSweep(makeCtx(), NOW + AUTO_CATCH_UP_SYNC_WAIT_MAX_MS);
    expect(enqueued.map((q) => q.prId)).toEqual([21]);
  });

  it('AI not ready during a catch-up: no skipped line on a head read before the sync', async () => {
    aiReady = false;
    answer = { prIds: [], autoToday: 0, verdictNeeded: [owed(30)] };
    fresh = () => false;
    const r = await runAutoReviewSweep(makeCtx(), NOW);
    expect(r.stopped).toBe('ai_not_ready');
    expect(skipPosts).toEqual([]);
    expect(freshAsks).toEqual([NOW]);
    // Once the workspace has synced, the skipped line is said.
    fresh = () => true;
    await runAutoReviewSweep(makeCtx(), NOW + 60_000);
    expect(skipPosts).toEqual([{ prId: 30, headSha: 'h30', reasons: ['not_ready'] }]);
    expect(enqueued).toEqual([]);
  });

  it("a reader's press does not wait for the sync", async () => {
    answer = { prIds: [21], autoToday: 0 };
    fresh = () => false;
    await runAutoReviewSweep(makeCtx(), NOW);
    expect(enqueued).toEqual([]);
    await runAutoReviewSweep(makeCtx(), NOW + 1_000, { accountId: 1, workspaceId: 7 });
    expect(enqueued.map((q) => q.prId)).toEqual([21]);
  });

  it('a host without the freshness seam does not wait', async () => {
    answer = { prIds: [21], autoToday: 0 };
    const ctx = makeCtx();
    delete (ctx.queries as { workspaceHeadsFreshSince?: unknown }).workspaceHeadsFreshSince;
    await runAutoReviewSweep(ctx, NOW);
    expect(enqueued.map((q) => q.prId)).toEqual([21]);
  });
});
