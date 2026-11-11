// TEAM CLAIMS in the auto lane (manager.ts `startAutoItem` + `launch`). Pinned:
//   • ⚠ A SKIP WRITES NO ROW: a PR a teammate's Limn holds is dropped before its row exists — no
//     failure, no retry count, no daily-cap use — and the next item still launches.
//   • a claimed run stores its record on the row, and when it ENDS (here: fails) its final line is
//     posted ("didn't finish · free to claim") on every exit path.
//   • a MANUAL run never claims.
//   • ⚠ ON THE READER'S OWN PR a teammate holding the pair's first half (Claude) stands the whole pair
//     down (no Codex half alone); on a teammate's PR the second half runs alone.
//   • ⚠ A MANUAL pair drops a half over its usage limit while the other can run.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

process.env.PRO_REVIEW_CONCURRENCY = '1';

const inserted: number[] = [];
const insertedRuns: Array<{ prId: number; provider: string; pair: unknown }> = [];
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
  insertQueuedReview: async (...args: unknown[]) => {
    const prId = args[1] as number;
    inserted.push(prId);
    insertedRuns.push({ prId, provider: args[7] as string, pair: args[9] ?? null });
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
// PRs whose workspace asks for Claude + Codex; PRs the reader authored; PRs a teammate holds on Claude.
const pairPrs = new Set<number>();
const ownPrs = new Set<number>();
const claudeHeld = new Set<number>();
vi.mock('./pair.js', async (orig) => ({
  ...(await orig<typeof import('./pair.js')>()),
  readAutoReviewProvidersForPr: async (_ctx: unknown, _a: number, prId: number) => (pairPrs.has(prId) ? 'both' : 'default'),
}));

const claimCalls: number[] = [];
const saved: Array<{ reviewId: number }> = [];
const finished: Array<{ reviewId: number | null; kind: string }> = [];
vi.mock('./team-claim.js', () => ({
  readerIsPrAuthor: async (_ctx: unknown, _a: number, prId: number) => ownPrs.has(prId),
  claimBeforeAutoRun: async (_ctx: unknown, t: { prId: number; provider: string }) => {
    claimCalls.push(t.prId);
    if (t.provider === 'claude' && claudeHeld.has(t.prId)) {
      return { kind: 'skip', skip: { provider: 'claude', kind: 'reviewed', login: 'robin', headSha: `h${t.prId}`, at: '' } };
    }
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

// THE SKIPPED LINE (team-claim-skip.ts): what the lane asked to say on a dropped item's head.
const skipLater: Array<{ prId: number; skips: Array<{ provider: string; reason: string; untilMs?: number | null }> }> = [];
vi.mock('./team-claim-skip.js', () => ({
  postAutoSkipLinesLater: (_ctx: unknown, a: { prId: number }, skips: any) => {
    void (async () => {
      skipLater.push({ prId: a.prId, skips: typeof skips === 'function' ? await skips() : skips });
    })();
  },
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
  insertedRuns.length = 0;
  pairPrs.clear();
  ownPrs.clear();
  claudeHeld.clear();
  claimCalls.length = 0;
  saved.length = 0;
  finished.length = 0;
  skipLater.length = 0;
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

describe('the skipped line (an item the lane drops before its row)', () => {
  it('over the spend budget: the head is said on the PR once, and no row is written', async () => {
    (ctx as any).aiBudget = { allowAutomaticRun: async () => false };
    m.enqueueAutoReview(ctx, 1, 60);
    await flush();
    expect(inserted).toEqual([]);
    expect(skipLater).toEqual([{ prId: 60, skips: [{ provider: expect.any(String), reason: 'budget' }] }]);
  });

  it('a press is not asked the budget: it runs normally, nothing is said', async () => {
    (ctx as any).aiBudget = { allowAutomaticRun: async () => false };
    m.enqueueAutoReview(ctx, 1, 61, undefined, null, { pressed: true });
    await flush();
    expect(inserted).toEqual([61]);
    expect(skipLater).toEqual([]);
    runs.shift()!.release();
    await flush();
  });

  it('every provider over its usage limit: the line names the limit and when it ends', async () => {
    const ul = await import('../../ai/usage-lockout.js');
    const { activeProviderId } = await import('../../ai/provider-setting.js');
    const p = activeProviderId();
    const at = Date.now();
    ul.noteProviderFailure(p, 'usage limit reached', at);
    ul.noteProviderFailure(p === 'claude' ? 'codex' : 'claude', 'usage limit reached', at);
    try {
      m.enqueueAutoReview(ctx, 1, 62);
      await flush();
      expect(inserted).toEqual([]);
      expect(skipLater).toEqual([{ prId: 62, skips: [{ provider: p, reason: 'usage_limit', untilMs: expect.any(Number) }] }]);
    } finally {
      ul.clearUsageLockout();
    }
  });

  it('a dropped RETRY or same-head comment burst says nothing (its head already carries our line)', async () => {
    (ctx as any).aiBudget = { allowAutomaticRun: async () => false };
    m.enqueueAutoReview(ctx, 1, 63, undefined, null, { retryOfReviewId: 9 });
    m.enqueueAutoReview(ctx, 1, 64, undefined, Date.now() - 60_000);
    await flush();
    expect(inserted).toEqual([]);
    expect(skipLater).toEqual([]);
  });
});

describe('a teammate holds Claude on a Claude + Codex pair', () => {
  it("⚠ the reader's own PR: the pair stands down — no Codex half alone, no row", async () => {
    pairPrs.add(42);
    ownPrs.add(42);
    claudeHeld.add(42);
    m.enqueueAutoReview(ctx, 1, 42);
    await flush();
    expect(claimCalls).toEqual([42]);
    expect(inserted).toEqual([]);
  });

  it("a teammate's PR: the Codex half runs alone, as before", async () => {
    pairPrs.add(43);
    claudeHeld.add(43);
    m.enqueueAutoReview(ctx, 1, 43);
    await flush();
    expect(claimCalls).toEqual([43, 43]);
    expect(insertedRuns).toEqual([{ prId: 43, provider: 'codex', pair: null }]);
    runs.shift()!.release();
    await flush();
  });
});

describe('a manual Claude + Codex review with one provider over its usage limit', () => {
  it('⚠ runs the provider with capacity alone; every provider locked ⇒ the pair as asked', async () => {
    const ul = await import('../../ai/usage-lockout.js');
    ul.noteProviderFailure('codex', "You've hit your usage limit. Try again in 3 hours.", Date.now());
    try {
      await m.startReview(ctx, 1, 70, 'claude-opus-5-5', 'claude', { pair: true });
      await flush();
      expect(insertedRuns).toEqual([{ prId: 70, provider: 'claude', pair: null }]);
      runs.shift()!.release();
      await flush();
      ul.noteProviderFailure('claude', 'usage limit reached', Date.now());
      await m.startReview(ctx, 1, 71, 'claude-opus-5-5', 'claude', { pair: true });
      await flush();
      expect(insertedRuns[1]).toEqual({ prId: 71, provider: 'claude', pair: { role: 'first' } });
      for (const r of runs.splice(0)) r.release();
      await flush();
    } finally {
      ul.clearUsageLockout();
    }
  });
});
