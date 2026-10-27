// TEAM CLAIMS × CLAUDE + CODEX PAIRS (manager.ts `startAutoItem` + `startPairSecond`). Pinned:
//   • each half of an AUTO pair claims its OWN provider's context, when that half starts;
//   • a first half a teammate holds is a half that never started: Codex runs ALONE (no pair row);
//   • a second half a teammate holds never starts (no row): the pair ends on its first half;
//   • the first half's line is held until the PAIR ends, then finished with the rest.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

process.env.PRO_REVIEW_CONCURRENCY = '1';

const inserted: Array<{ prId: number; provider: string; pair: unknown }> = [];
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
  insertQueuedReview: async (
    _ctx: unknown,
    prId: number,
    _head: string,
    _model: string,
    _account: number,
    _tickets: unknown,
    _trigger: string,
    provider: string,
    _fresh: boolean,
    pair: unknown,
  ) => {
    inserted.push({ prId, provider, pair: pair ?? null });
    return nextId++;
  },
  getClaudeReviewById: async () => null,
  getLatestClaudeReview: async () => null,
  isAutoReReviewSettled: async () => false,
  markReviewCancelled: async () => {},
  markReviewFailed: async () => {},
  markReviewRouted: async () => {},
  reconcileOrphanedReviews: async () => 0,
  saveReviewSuccess: async () => {},
}));
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => true }));
vi.mock('./pair.js', async (orig) => ({
  ...(await orig<typeof import('./pair.js')>()),
  readAutoReviewProvidersForPr: async () => 'both',
}));

// Which (prId, provider) a teammate holds.
let held = new Set<string>();
const claimCalls: string[] = [];
const saved: number[] = [];
const finished: Array<{ reviewId: number | null; context: string; kind: string }> = [];
vi.mock('./team-claim.js', () => ({
  claimBeforeAutoRun: async (_ctx: unknown, t: { prId: number; provider: string }) => {
    claimCalls.push(`${t.prId}:${t.provider}`);
    if (held.has(`${t.prId}:${t.provider}`)) {
      return { kind: 'skip', skip: { provider: t.provider, kind: 'reviewing', login: 'bob', headSha: `h${t.prId}`, at: '' } };
    }
    return {
      kind: 'run',
      handle: {
        target: t,
        login: 'me',
        marked: true,
        timer: null,
        record: { context: `limn/review-${t.provider}`, state: 'marked', reason: null, lastLine: 'reviewing', at: '' },
      },
    };
  },
  saveTeamClaimRecord: async (_ctx: unknown, reviewId: number) => {
    saved.push(reviewId);
  },
  startTeamClaimRenew: () => {},
  stopTeamClaimRenew: () => {},
  finishTeamClaim: async (
    _ctx: unknown,
    h: { record: { context: string } },
    reviewId: number | null,
    outcome: { kind: string },
  ) => {
    finished.push({ reviewId, context: h.record.context, kind: outcome.kind });
  },
  postedReviewUrl: () => null,
}));

let m: typeof import('./manager.js');
let runs: Array<{ prId: number; release: () => void }> = [];
let ctx: AgentContext;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(async () => {
  vi.resetModules();
  inserted.length = 0;
  claimCalls.length = 0;
  saved.length = 0;
  finished.length = 0;
  held = new Set();
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
  /* eslint-enable @typescript-eslint/no-explicit-any */
  m = await import('./manager.js');
});

describe('team claims on a Claude + Codex pair', () => {
  it('each half claims its own context when it starts; the first line waits for the pair to end', async () => {
    m.enqueueAutoReview(ctx, 1, 60);
    await flush();
    expect(claimCalls).toEqual(['60:claude']);
    expect(inserted).toEqual([{ prId: 60, provider: 'claude', pair: { role: 'first' } }]);
    runs.shift()!.release(); // Claude's half ends (fails)
    await flush();
    // The second half claimed Codex's context and started; Claude's line is still held.
    expect(claimCalls).toEqual(['60:claude', '60:codex']);
    expect(inserted[1]).toEqual({ prId: 60, provider: 'codex', pair: { role: 'second', pairId: 1 } });
    expect(saved).toEqual([1, 2]);
    expect(finished).toEqual([]);
    runs.shift()!.release(); // Codex's half ends
    await flush();
    expect(finished.map((f) => f.context).sort()).toEqual(['limn/review-claude', 'limn/review-codex']);
    expect(finished.every((f) => f.kind === 'unfinished')).toBe(true);
  });

  it('a first half a teammate holds never starts: Codex runs alone', async () => {
    held.add('61:claude');
    m.enqueueAutoReview(ctx, 1, 61);
    await flush();
    expect(claimCalls).toEqual(['61:claude', '61:codex']);
    expect(inserted).toEqual([{ prId: 61, provider: 'codex', pair: null }]);
    runs.shift()!.release();
    await flush();
    expect(inserted).toHaveLength(1);
    expect(finished).toEqual([{ reviewId: 1, context: 'limn/review-codex', kind: 'unfinished' }]);
  });

  it('a second half a teammate holds gets no row: the pair ends on its first half', async () => {
    held.add('62:codex');
    m.enqueueAutoReview(ctx, 1, 62);
    await flush();
    runs.shift()!.release();
    await flush();
    expect(claimCalls).toEqual(['62:claude', '62:codex']);
    expect(inserted).toHaveLength(1);
    expect(runs).toHaveLength(0);
    expect(finished).toEqual([{ reviewId: 1, context: 'limn/review-claude', kind: 'unfinished' }]);
  });

  it('both held: nothing runs and no row is written', async () => {
    held.add('63:claude');
    held.add('63:codex');
    m.enqueueAutoReview(ctx, 1, 63);
    await flush();
    expect(inserted).toEqual([]);
    expect(runs).toHaveLength(0);
  });
});
