// The CI review queue (manager.ts) — claims and lane order, with persistence and the shared slot
// counter faked (no DB, no SDK). What this pins:
//   1. ⚠ The claim is SYNCHRONOUS: two starts of one PR in the same tick queue ONE run.
//   2. A manual item goes ahead of every automatic one; nothing starts while no shared slot is free.
//   3. The automatic lane has its own cap ('busy'), so the sweeper can never crowd out a click.
//
//   pnpm --filter @pierre-review/backend test ci-review/manager
import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

let nextId = 100;
vi.mock('./persist.js', () => ({
  insertQueuedCiReview: async () => (nextId += 1),
  reconcileOrphanedCiReviews: async () => 0,
  markCiReviewCancelled: async () => {},
}));
let peer: { inFlight: () => number; pump: () => void } | null = null;
vi.mock('../claude-review/manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  REVIEW_APPLY_AUTH_ENV: false,
  registerReviewSlotPeer: (p: typeof peer) => {
    peer = p;
  },
  reviewSlotFree: () => false,
  reviewLaneWaiting: () => ({ manual: false, auto: false }),
  pumpReviewLane: () => {},
}));

const m = await import('./manager.js');
const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as AgentContext;
const args = (prId: number, trigger: 'manual' | 'auto' = 'manual') => ({
  accountId: 1,
  workspaceId: 1,
  prId,
  repoId: 1,
  headSha: 'h',
  triggerKey: trigger === 'auto' ? 'k' : null,
  trigger,
});

describe('CI review queue', () => {
  it('registers with the shared slot counter', () => {
    expect(peer?.inFlight()).toBe(0);
  });

  it('⚠ claims synchronously: one run per PR', async () => {
    const [a, b] = await Promise.all([m.startCiReview(ctx, args(1)), m.startCiReview(ctx, args(1))]);
    expect(a.outcome).toBe('queued');
    expect(b.outcome).toBe('already_running');
    expect(m.ciReviewHeld(1, 1)).toBe(true);
    expect(m.ciReviewHeld(2, 1)).toBe(false);
  });

  it('puts a click ahead of automatic items and starts nothing without a slot', async () => {
    await m.startCiReview(ctx, args(2, 'auto'));
    await m.startCiReview(ctx, args(3, 'manual'));
    expect(m._ciLaneForTest().map((j) => j.prId)).toEqual([1, 3, 2]);
    expect(peer?.inFlight()).toBe(0);
  });

  it('caps the automatic lane on its own', async () => {
    let room = m.ciAutoLaneRoom();
    for (let i = 0; room > 0; i += 1, room -= 1) await m.startCiReview(ctx, args(100 + i, 'auto'));
    expect((await m.startCiReview(ctx, args(999, 'auto'))).outcome).toBe('busy');
    expect((await m.startCiReview(ctx, args(998, 'manual'))).outcome).toBe('queued');
  });

  it('a queued run can be cancelled by its own account only, and frees its claim', async () => {
    const r = await m.startCiReview(ctx, args(777, 'manual'));
    if (r.outcome !== 'queued') throw new Error('expected queued');
    expect(m.requestCiReviewCancel(2, r.runId)).toBe(false);
    expect(m.ciReviewHeld(1, 777)).toBe(true);
    expect(m.requestCiReviewCancel(1, r.runId)).toBe(true);
    expect(m.ciReviewHeld(1, 777)).toBe(false);
    expect(m._ciLaneForTest().some((j) => j.prId === 777)).toBe(false);
  });
});
