// TEAM CLAIMS in the auto lane (manager.ts `startAutoItem` + `launch`). Pinned:
//   • ⚠ A SKIP WRITES NO ROW: a PR a teammate's Limn holds is dropped before its row exists — no
//     failure, no retry count, no daily-cap use — and the next item still launches.
//   • a claimed run stores its record on the row, and when it ENDS (here: fails) its final line is
//     posted ("didn't finish · free to claim") on every exit path.
//   • a MANUAL run never claims.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

process.env.PRO_REVIEW_CONCURRENCY = '1';

const inserted: number[] = [];
let nextId = 1;
vi.mock('./persist.js', () => ({
  getReviewPrContext: async (_ctx: unknown, prId: number) => ({
    owner: 'acme',
    name: 'api',
    number: prId,
    title: `PR ${prId}`,
    body: null,
    headSha: `h${prId}`,
    baseRefName: 'main',
    repoFullName: 'acme/api',
  }),
  insertQueuedReview: async (_ctx: unknown, prId: number) => {
    inserted.push(prId);
    return nextId++;
  },
  getLatestClaudeReview: async () => null,
  isAutoReReviewSettled: async () => false,
  markReviewCancelled: async () => {},
  markReviewFailed: async () => {},
  markReviewRouted: async () => {},
  reconcileOrphanedReviews: async () => 0,
  saveReviewSuccess: async () => {},
}));
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => true }));

const claimCalls: number[] = [];
const saved: Array<{ reviewId: number }> = [];
const finished: Array<{ reviewId: number | null; kind: string }> = [];
vi.mock('./team-claim.js', () => ({
  claimBeforeAutoRun: async (_ctx: unknown, t: { prId: number }) => {
    claimCalls.push(t.prId);
    if (t.prId === 40) {
      return { kind: 'skip', skip: { provider: 'claude', kind: 'reviewing', login: 'bob', headSha: 'h40', at: '' } };
    }
    return {
      kind: 'run',
      handle: {
        target: t,
        login: 'me',
        marked: true,
        timer: null,
        record: { context: 'limn/review-claude', state: 'marked', reason: null, lastLine: 'reviewing', at: '' },
      },
    };
  },
  saveTeamClaimRecord: async (_ctx: unknown, reviewId: number) => {
    saved.push({ reviewId });
  },
  startTeamClaimRenew: () => {},
  stopTeamClaimRenew: () => {},
  finishTeamClaim: async (_ctx: unknown, _h: unknown, reviewId: number | null, outcome: { kind: string }) => {
    finished.push({ reviewId, kind: outcome.kind });
  },
  postedReviewUrl: () => null,
}));

let m: typeof import('./manager.js');
let runs: Array<{ prId: number; release: () => void }> = [];
let ctx: AgentContext;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(async () => {
  vi.resetModules();
  inserted.length = 0;
  claimCalls.length = 0;
  saved.length = 0;
  finished.length = 0;
  nextId = 1;
  runs = [];
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ctx = {
    log: { error: () => {}, info: () => {}, warn: () => {} },
    review: {
      prepareReview: ({ prNumber }: { prNumber: number }) =>
        new Promise((_res, rej) => {
          runs.push({ prId: prNumber, release: () => rej(new Error('released')) });
        }),
    },
  } as any as AgentContext;
  m = await import('./manager.js');
});

describe('team claims in the auto lane', () => {
  it('⚠ a skipped PR gets NO row, and the next auto item still launches', async () => {
    expect(m.enqueueAutoReview(ctx, 1, 40)).toBe('queued');
    expect(m.enqueueAutoReview(ctx, 1, 41)).toBe('queued');
    await flush();
    expect(claimCalls).toEqual([40, 41]);
    expect(inserted).toEqual([41]);
    expect(runs.map((r) => r.prId)).toEqual([41]);
    expect(m.autoPendingPrIds().has(40)).toBe(false);
  });

  it('a claimed run stores its record, and its end posts the final line', async () => {
    m.enqueueAutoReview(ctx, 1, 41);
    await flush();
    expect(saved).toEqual([{ reviewId: 1 }]);
    runs.shift()!.release(); // the run fails
    await flush();
    expect(finished).toEqual([{ reviewId: 1, kind: 'unfinished' }]);
  });

  it('a manual run never claims', async () => {
    await m.startReview(ctx, 1, 50, 'claude-opus-5-5');
    await flush();
    expect(claimCalls).toEqual([]);
    runs.shift()!.release();
    await flush();
    expect(finished).toEqual([]);
  });
});
