// THE AUTO LANE in the Claude Review manager — the half of auto review that decides WHEN a run
// starts. What is pinned:
//
//   1. ⚠ A CLICK ALWAYS GOES FIRST. Auto items launch only when no manual item is waiting, and the
//      ONE shared PRO_REVIEW_CONCURRENCY is unchanged.
//   2. ⚠ AUTO WORK NEVER MAKES A CLICK ANSWER 'busy'. The lane has its own cap; filling it does not
//      touch the manual queue's.
//   3. ⚠ WHILE AN AUTO REVIEW IS QUEUED OR RUNNING, MANUAL START IS LOCKED ('auto_in_progress'),
//      and the status + active list say so. Once the auto run ends, a manual run is allowed again.
//   4. A waiting auto item has NO ROW: the row (trigger 'auto', the manual default model) is written
//      when a slot opens, so a restart loses nothing — the sweeper finds the PR again.
//   5. ⚠ AI GONE BY THE TIME A SLOT OPENS (runtime removed, signed out): the item is dropped BEFORE
//      its row is written, so the PR's one automatic review is not spent on a failure.
//
// The persistence layer and the agent are mocked; `prepareReview` hands back a promise the test
// settles, which is how a "running" slot is held open and released.
//
//   pnpm --filter @pierre-review/backend test claude-review/auto-lane
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext as ProContext } from '../agent-context.js';

process.env.PRO_REVIEW_CONCURRENCY = '1';
process.env.PRO_REVIEW_MAX_QUEUED = '2';
process.env.PRO_REVIEW_AUTO_MAX_QUEUED = '2';

const inserted: Array<{ prId: number; model: string; trigger: string; id: number; ticket: unknown }> = [];
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
    model: string,
    _account: number,
    ticket: unknown,
    trigger = 'manual',
  ) => {
    const id = nextId++;
    inserted.push({ prId, model, trigger, id, ticket });
    return id;
  },
  getLatestClaudeReview: async () => null,
  loadPriorReviewForFollowUp: async () => null,
  markReviewCancelled: async () => {},
  markReviewFailed: async () => {},
  markReviewRouted: async () => {},
  reconcileOrphanedReviews: async () => 0,
  saveReviewSuccess: async () => {},
}));
// The server-side Jira fill for auto runs — the OPTIONAL Pro provider (plugin-providers.ts): PR 60
// carries a ticket, every other PR has none.
const AUTO_TICKET = { title: 'Reset password', description: null, acceptanceCriteria: '* Link is emailed' };
vi.mock('../plugin-providers.js', () => ({
  getAgenticProviders: () => ({
    resolveReviewTicket: async (_account: number, prId: number) =>
      prId === 60 ? { ticket: AUTO_TICKET, key: 'ENG-7' } : { ticket: null, key: null },
  }),
}));
let aiReady = true;
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => aiReady }));
vi.mock('../memory/retrieval.js', () => ({
  buildLearningsContext: async () => undefined,
}));

type Manager = typeof import('./manager.js');
let m: Manager;
// One deferred per launched run, in launch order; rejecting one frees its slot.
let runs: Array<{ prId: number; release: () => void }> = [];
let ctx: ProContext;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(async () => {
  vi.resetModules();
  inserted.length = 0;
  nextId = 1;
  runs = [];
  aiReady = true;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ctx = {
    log: { error: () => {}, info: () => {}, warn: () => {} },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    review: {
      prepareReview: ({ prNumber }: { prNumber: number }) =>
        new Promise((_res, rej) => {
          runs.push({ prId: prNumber, release: () => rej(new Error('released')) });
        }),
    },
  } as any as ProContext;
  m = await import('./manager.js');
});

const releaseFirst = async (): Promise<void> => {
  runs.shift()!.release();
  await flush();
};

describe('the auto lane', () => {
  it('⚠ writes NO row when AI is not ready at launch — the PR still qualifies later', async () => {
    aiReady = false;
    expect(m.enqueueAutoReview(ctx, 1, 20)).toBe('queued');
    await flush();
    expect(inserted).toEqual([]);
    expect(runs).toEqual([]);
    expect(m.autoPendingPrIds().has(20)).toBe(false);
    aiReady = true;
    expect(m.enqueueAutoReview(ctx, 1, 20)).toBe('queued');
    await flush();
    expect(inserted.map((r) => r.prId)).toEqual([20]);
  });

  it('writes NO row while an auto item waits, and stamps trigger auto + the default model at launch', async () => {
    // Occupy the one slot with a manual run.
    await m.startReview(ctx, 1, 10, 'claude-opus-5-5', 'auto');
    await flush();
    expect(m.enqueueAutoReview(ctx, 1, 20)).toBe('queued');
    await flush();
    expect(inserted.map((r) => r.prId)).toEqual([10]); // nothing for 20 yet
    expect(m.autoPendingPrIds().has(20)).toBe(true);

    await releaseFirst();
    const auto = inserted.find((r) => r.prId === 20);
    expect(auto).toMatchObject({ trigger: 'auto', model: 'claude-opus-5-5' });
    expect(runs.map((r) => r.prId)).toEqual([20]);
  });

  it('⚠ a queued MANUAL click launches before a queued auto item', async () => {
    await m.startReview(ctx, 1, 10, 'claude-opus-5-5', 'auto'); // running
    await flush();
    m.enqueueAutoReview(ctx, 1, 20); // waiting in the auto lane
    const manual = await m.startReview(ctx, 1, 30, 'claude-opus-5-5', 'auto'); // waiting, manual
    expect(manual).toMatchObject({ ok: true, queued: true });

    await releaseFirst();
    expect(runs.map((r) => r.prId)).toEqual([30]);
    await releaseFirst();
    expect(runs.map((r) => r.prId)).toEqual([20]);
  });

  it('⚠ a full auto lane never makes a click answer busy', async () => {
    await m.startReview(ctx, 1, 10, 'claude-opus-5-5', 'auto');
    await flush();
    expect(m.enqueueAutoReview(ctx, 1, 20)).toBe('queued');
    expect(m.enqueueAutoReview(ctx, 1, 21)).toBe('queued');
    expect(m.enqueueAutoReview(ctx, 1, 22)).toBe('full');
    expect(m.autoLaneRoom()).toBe(0);
    // The manual queue (cap 2) is untouched by the auto lane.
    expect(await m.startReview(ctx, 1, 30, 'claude-opus-5-5', 'auto')).toMatchObject({ ok: true });
    expect(await m.startReview(ctx, 1, 31, 'claude-opus-5-5', 'auto')).toMatchObject({ ok: true });
    expect(await m.startReview(ctx, 1, 32, 'claude-opus-5-5', 'auto')).toEqual({
      ok: false,
      reason: 'busy',
    });
  });

  it('⚠ a click on a PR waiting in the lane is refused, and the lane keeps it', async () => {
    await m.startReview(ctx, 1, 10, 'claude-opus-5-5', 'auto');
    await flush();
    m.enqueueAutoReview(ctx, 1, 20);
    expect(m.autoReviewHold(20, 1)).toBe('queued');
    expect(m.autoReviewHold(20, 2)).toBeNull(); // another account's view: nothing
    const r = await m.startReview(ctx, 1, 20, 'claude-opus-5-5', 'auto');
    expect(r).toEqual({ ok: false, reason: 'auto_in_progress', auto: 'queued' });
    expect(m.autoPendingPrIds().has(20)).toBe(true);
    expect(inserted.some((x) => x.prId === 20)).toBe(false);
  });

  it('exposes a waiting auto item through the status and the active list', async () => {
    await m.startReview(ctx, 1, 10, 'claude-opus-5-5', 'auto');
    await flush();
    m.enqueueAutoReview(ctx, 1, 20);
    expect(await m.getReviewStatus(ctx, 1, 20)).toEqual({
      status: 'queued',
      reviewId: null,
      progress: null,
      trigger: 'auto',
    });
    const active = await m.listActiveReviews(1);
    expect(active).toContainEqual(
      expect.objectContaining({ prId: 20, reviewId: null, status: 'queued', trigger: 'auto' }),
    );
    expect(await m.listActiveReviews(2)).toEqual([]);
  });

  it('⚠ locks manual start while the auto run RUNS, and frees it once it ends', async () => {
    m.enqueueAutoReview(ctx, 1, 20);
    await flush();
    expect(m.autoReviewHold(20, 1)).toBe('running');
    expect(await m.startReview(ctx, 1, 20, 'claude-opus-5-5', 'auto')).toEqual({
      ok: false,
      reason: 'auto_in_progress',
      auto: 'running',
    });
    await releaseFirst(); // the auto run ends (here: fails)
    expect(m.autoReviewHold(20, 1)).toBeNull();
    expect(await m.startReview(ctx, 1, 20, 'claude-opus-5-5', 'auto')).toMatchObject({ ok: true });
    expect(inserted.filter((x) => x.prId === 20).map((x) => x.trigger)).toEqual(['auto', 'manual']);
  });

  it('an account whose credits ran out mid-wait is skipped at launch, with no row', async () => {
    await m.startReview(ctx, 1, 10, 'claude-opus-5-5', 'auto');
    await flush();
    m.enqueueAutoReview(ctx, 2, 40);
    (ctx as any).aiCredits.check = async (a: number) => ({ agentBlocked: a === 2 });
    await releaseFirst();
    expect(inserted.some((r) => r.prId === 40)).toBe(false);
    expect(m.autoPendingPrIds().size).toBe(0);
  });

  it('⚠ an auto run stores the ticket the server fetched from Jira', async () => {
    m.enqueueAutoReview(ctx, 1, 60);
    await flush();
    expect(inserted.find((r) => r.prId === 60)).toMatchObject({ trigger: 'auto', ticket: AUTO_TICKET });
    await releaseFirst();
    m.enqueueAutoReview(ctx, 1, 61);
    await flush();
    expect(inserted.find((r) => r.prId === 61)).toMatchObject({ trigger: 'auto', ticket: null });
  });

  it('reports an auto run as auto in the active list', async () => {
    m.enqueueAutoReview(ctx, 1, 50);
    await flush();
    const active = await m.listActiveReviews(1);
    expect(active).toEqual([expect.objectContaining({ prId: 50, trigger: 'auto', status: 'running' })]);
  });
  it('⚠ switching a workspace off drops its WAITING items (no row, no run), and only its own', async () => {
    await m.startReview(ctx, 1, 10, 'claude-opus-5-5', 'auto'); // holds the one slot
    await flush();
    expect(m.enqueueAutoReview(ctx, 1, 20, 7)).toBe('queued');
    expect(m.enqueueAutoReview(ctx, 1, 21, 8)).toBe('queued');
    expect(m.dropAutoReviews((a, w) => !(a === 1 && w === 7))).toBe(1);
    expect(m._autoLaneForTest()).toEqual([{ accountId: 1, prId: 21 }]);
    expect(m.autoReviewHold(20, 1)).toBeNull(); // the manual lock is lifted

    await releaseFirst();
    expect(inserted.map((r) => r.prId)).toEqual([10, 21]); // 20 never got a row
  });
});
