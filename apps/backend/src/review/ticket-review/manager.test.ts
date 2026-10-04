// The ticket review queue (manager.ts) — claims and lane order, with persistence and the shared
// slot counter faked (no DB, no SDK). What this pins:
//   1. ⚠ The claim is SYNCHRONOUS: two starts of one ticket in the same tick queue ONE run.
//   2. A manual item goes ahead of every automatic one; nothing starts while no shared slot is free.
//   3. The automatic lane has its own cap ('busy'), so the sweeper can never crowd out a click.
//
//   pnpm --filter @pierre-review/backend test ticket-review/manager
import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

let nextId = 100;
vi.mock('./persist.js', () => ({
  insertQueuedTicketReview: async () => (nextId += 1),
  reconcileOrphanedTicketReviews: async () => 0,
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
const args = (ident: string, trigger: 'manual' | 'auto' | 'cascade' = 'manual') => ({
  accountId: 1,
  workspaceId: 1,
  ident,
  ticketKey: null,
  ticketTitle: null,
  manualTicket: null,
  originPrId: 5,
  trigger,
});

describe('ticket review queue', () => {
  it('registers with the shared slot counter', () => {
    expect(peer?.inFlight()).toBe(0);
  });

  it('⚠ claims synchronously: one run per ticket', async () => {
    const [a, b] = await Promise.all([m.startTicketReview(ctx, args('jira:x#A-1')), m.startTicketReview(ctx, args('jira:x#A-1'))]);
    expect(a.outcome).toBe('queued');
    expect(b.outcome).toBe('already_running');
    expect(m.ticketReviewHeld(1, 'jira:x#A-1')).toBe(true);
    expect(m.ticketReviewHeld(2, 'jira:x#A-1')).toBe(false);
  });

  it('puts a click ahead of automatic items and starts nothing without a slot', async () => {
    await m.startTicketReview(ctx, args('jira:x#B-1', 'cascade'));
    await m.startTicketReview(ctx, args('jira:x#B-2', 'manual'));
    expect(m._ticketLaneForTest().map((j) => j.ident)).toEqual(['jira:x#A-1', 'jira:x#B-2', 'jira:x#B-1']);
    expect(peer?.inFlight()).toBe(0);
  });

  it('caps the automatic lane on its own', async () => {
    let room = m.ticketAutoLaneRoom();
    for (let i = 0; room > 0; i += 1, room -= 1) await m.startTicketReview(ctx, args(`jira:x#C-${i}`, 'auto'));
    expect((await m.startTicketReview(ctx, args('jira:x#D-1', 'auto'))).outcome).toBe('busy');
    expect((await m.startTicketReview(ctx, args('jira:x#D-2', 'manual'))).outcome).toBe('queued');
  });
});
