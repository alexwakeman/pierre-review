// A TEAMMATE'S CLAIM HOLDS A MOVED HEAD, AND THE READER REPLIED (auto.ts `teamClaimRepliesDue`;
// docs/CLAUDE-REVIEW.md § The replies pass). The reader's full review of the new head is skipped for
// the teammate's claim, so their replies on their own Limn findings are judged by a REPLIES PASS at
// the current head — the same per-PR daily cap, the budget gate inside `startRepliesCheck`, asked at
// most once per head per settle wait. A same-head comment burst is untouched by it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

const enqueued: number[] = [];
vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  dropAutoReviews: () => 0,
  autoLaneRoom: () => 20,
  autoPendingPrIds: () => new Set<number>(),
  enqueueAutoReview: (_ctx: unknown, _accountId: number, prId: number) => {
    enqueued.push(prId);
    return 'queued';
  },
}));
vi.mock('./team-claim-skip.js', () => ({
  postAutoSkipLines: async (_ctx: unknown, _a: unknown, skips: unknown[]) => skips.map(() => 'posted'),
  autoProvidersForPr: async () => ['claude'],
}));
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => true }));
vi.mock('./auto-settings.js', () => ({
  listAutoReviewWorkspaces: async () => [{ accountId: 1, workspaceId: 7, enabledAtMs: 0, dailyCap: 20 }],
}));
let heldHead: string | null = 'h2';
vi.mock('./team-claim.js', () => ({ teamClaimHeldHeadNow: async () => heldHead }));
const repliesStarts: Array<{ prId: number; trigger: string }> = [];
let repliesUsed = 0;
vi.mock('./replies-check.js', () => ({
  repliesCheckHeld: () => false,
  repliesCheckAutoRoom: () => 20,
  countAutoRepliesPassesSince: async () => repliesUsed,
  startRepliesCheck: async (_ctx: unknown, a: { prId: number; trigger: string }) => {
    repliesStarts.push(a);
    return { outcome: 'queued', reviewId: 900, threads: 1 };
  },
}));
vi.mock('./thread-check.js', () => ({ threadCheckHeld: () => false, threadCheckAutoRoom: () => 20, startThreadCheck: async () => ({ outcome: 'queued' }) }));
vi.mock('./thread-check-persist.js', () => ({ getLatestThreadCheck: async () => null, countAutoThreadChecksSince: async () => 0 }));
vi.mock('../ci-review/persist.js', () => ({ getCiPrContext: async () => ({ repoId: 3 }) }));

const { runAutoReviewSweep, teamClaimRepliesDue, AUTO_REREVIEW_SETTLE_MS, _resetAutoReReviewForTest } = await import('./auto.js');

const NOW = Date.UTC(2026, 10, 9, 16, 50);
/* eslint-disable @typescript-eslint/no-explicit-any */
let reReview: any[] = [];
const ctx = {
  host: {},
  log: { info: () => {}, warn: () => {}, error: () => {} },
  queries: { getAutoReviewCandidates: async () => ({ prIds: [], autoToday: 0, reReview, inFlightMoved: [], retry: [] }) },
} as any as AgentContext;

beforeEach(() => {
  _resetAutoReReviewForTest();
  enqueued.length = 0;
  repliesStarts.length = 0;
  repliesUsed = 0;
  heldHead = 'h2';
  reReview = [{ prId: 30, headSha: 'h2', commentsAtMs: null, lastRunAtMs: NOW - 10 * 60_000 }];
});

describe('teamClaimRepliesDue (pure)', () => {
  it('once per head per settle wait', () => {
    expect(teamClaimRepliesDue(undefined, 'h2', NOW)).toBe(true);
    expect(teamClaimRepliesDue({ headSha: 'h2', atMs: NOW }, 'h2', NOW + 1000)).toBe(false);
    expect(teamClaimRepliesDue({ headSha: 'h2', atMs: NOW }, 'h2', NOW + AUTO_REREVIEW_SETTLE_MS)).toBe(true);
    expect(teamClaimRepliesDue({ headSha: 'h1', atMs: NOW }, 'h2', NOW + 1000)).toBe(true);
  });
});

describe('a moved head held by a teammate’s claim', () => {
  it('starts a replies pass instead of the skipped full review — once per settle wait', async () => {
    await runAutoReviewSweep(ctx, NOW);
    expect(enqueued).toEqual([]);
    expect(repliesStarts.map((r) => [r.prId, r.trigger])).toEqual([[30, 'auto']]);
    await runAutoReviewSweep(ctx, NOW + 1000);
    expect(repliesStarts).toHaveLength(1);
  });

  it('⚠ past the per-PR daily cap: no pass', async () => {
    repliesUsed = 5;
    await runAutoReviewSweep(ctx, NOW);
    expect(repliesStarts).toHaveLength(0);
  });

  it('not held: the ordinary full review, no replies pass', async () => {
    heldHead = null;
    await runAutoReviewSweep(ctx, NOW);
    expect(enqueued).toEqual([30]);
    expect(repliesStarts).toHaveLength(0);
  });
});
