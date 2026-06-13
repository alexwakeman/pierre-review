import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../sync/sync-repo.js';

// Exercise the concurrency gate + FIFO queue without a real DB / agent. `runReview`
// returns a promise we resolve by hand to hold a review "running"; config is a
// mutable object so a test can set the concurrency / queue caps.
const h = vi.hoisted(() => {
  const resolvers: Array<() => void> = [];
  const runReview = vi.fn(
    () =>
      new Promise<void>((res) => {
        resolvers.push(res);
      }),
  );
  const cfg = { claudeReviewEnabled: true, reviewConcurrency: 2, reviewMaxQueued: 3 };
  let nextId = 100;
  const insertQueuedReview = vi.fn(async () => ++nextId);
  const markReviewCancelled = vi.fn(async () => {});
  const getReviewPrContext = vi.fn(async (prId: number) => ({
    owner: 'o',
    name: 'n',
    repoFullName: 'o/n',
    number: prId,
    title: `t${prId}`,
    body: '',
    baseRefName: 'main',
    headSha: `sha${prId}`,
  }));
  return { resolvers, runReview, cfg, insertQueuedReview, markReviewCancelled, getReviewPrContext };
});

vi.mock('../config.js', () => ({ config: h.cfg }));
vi.mock('../auth/account.js', () => ({ LOCAL_ACCOUNT_ID: 1 }));
vi.mock('./agent.js', () => ({ runReview: h.runReview }));
vi.mock('./persist.js', () => ({
  insertQueuedReview: h.insertQueuedReview,
  markReviewCancelled: h.markReviewCancelled,
  reconcileOrphanedReviews: vi.fn(async () => 0),
}));
vi.mock('../db/queries.js', () => ({
  getReviewPrContext: h.getReviewPrContext,
  getLatestClaudeReview: vi.fn(async () => null),
}));

const { startReview, getReviewStatus, requestReviewCancel } = await import(
  './review-manager.js'
);

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('review-manager queue', () => {
  it('runs up to concurrency, queues the rest, and pumps on completion', async () => {
    h.cfg.reviewConcurrency = 2;
    h.cfg.reviewMaxQueued = 3;

    // Two slots → first two run immediately.
    const r1 = await startReview(1, 'claude-sonnet-4-6', 'auto', log);
    const r2 = await startReview(2, 'claude-sonnet-4-6', 'auto', log);
    expect(r1).toMatchObject({ ok: true, queued: false });
    expect(r2).toMatchObject({ ok: true, queued: false });
    expect(h.runReview).toHaveBeenCalledTimes(2);

    // Third has no slot → queued (runReview not yet called for it).
    const r3 = await startReview(3, 'claude-sonnet-4-6', 'auto', log);
    expect(r3).toMatchObject({ ok: true, queued: true });
    expect(h.runReview).toHaveBeenCalledTimes(2);
    expect(await getReviewStatus(3)).toMatchObject({ status: 'queued' });

    // Re-triggering a running OR queued PR is rejected (no double-start).
    expect(await startReview(1, 'claude-sonnet-4-6', 'auto', log)).toMatchObject({
      ok: false,
      reason: 'already_running',
    });
    expect(await startReview(3, 'claude-sonnet-4-6', 'auto', log)).toMatchObject({
      ok: false,
      reason: 'already_running',
    });

    // Finish review #1 → its slot frees → the queued #3 launches.
    h.resolvers.shift()!(); // resolve pr1's runReview
    await flush();
    expect(h.runReview).toHaveBeenCalledTimes(3);
    expect(await getReviewStatus(3)).toMatchObject({ status: 'running' });

    // Drain the rest so module state doesn't leak.
    while (h.resolvers.length) h.resolvers.shift()!();
    await flush();
  });

  it('caps the queue and cancels a queued item', async () => {
    h.cfg.reviewConcurrency = 1;
    h.cfg.reviewMaxQueued = 2;

    const a = await startReview(11, 'claude-sonnet-4-6', 'auto', log); // running
    const b = await startReview(12, 'claude-sonnet-4-6', 'auto', log); // queued (1)
    const c = await startReview(13, 'claude-sonnet-4-6', 'auto', log); // queued (2)
    expect(a).toMatchObject({ ok: true, queued: false });
    expect(b).toMatchObject({ ok: true, queued: true });
    expect(c).toMatchObject({ ok: true, queued: true });

    // Queue full (2) → next is rejected.
    expect(await startReview(14, 'claude-sonnet-4-6', 'auto', log)).toMatchObject({
      ok: false,
      reason: 'busy',
    });

    // Cancel a QUEUED item → drops it + marks the row cancelled, frees the slot.
    expect(requestReviewCancel(13)).toBe(true);
    expect(h.markReviewCancelled).toHaveBeenCalled();
    // Now there's room again.
    expect(await startReview(14, 'claude-sonnet-4-6', 'auto', log)).toMatchObject({
      ok: true,
      queued: true,
    });

    while (h.resolvers.length) h.resolvers.shift()!();
    await flush();
  });
});
