// `armedPhaseHeadline` — THE ONE spelling of "where a live armed intent stands", shared by the
// AutoMergeBanner stack and the Pending board's merge row.
//
// WHAT THIS PINS, and the defect it was written for: the two halves of a `queued_local` row are
// read at DIFFERENT TIMES. `phase` is whatever the watcher last STORED — up to a full cron tick,
// two minutes, ago — while `queuePosition`/`queueDepth` are recomputed LIVE on every request from
// the current set of armed intents. The ordinary case is the slot-holder merging inside the same
// tick that parked this row, which left the card reading "Waiting its turn — 1 of 1 on this repo":
// a queue of one, with the row itself at the head of it, for up to two minutes. A wait needs
// somebody AHEAD, so the position is checked rather than assumed.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { ArmedMergeRequest } from '@pierre-review/shared';
import { armedPhaseHeadline } from '../src/components/AutoMergeBanner.js';

function queuedLocal(over: Partial<ArmedMergeRequest> = {}): ArmedMergeRequest {
  return {
    prId: 41,
    repoOwner: 'acme',
    repoName: 'api',
    prNumber: 441,
    prTitle: 'Bump the thing',
    mergeMethod: 'squash',
    updateStrategy: 'none',
    viaMergeQueue: false,
    enqueuedAt: null,
    armedAt: '2026-08-28T10:00:00.000Z',
    expectedHeadOid: 'aaaaaaa',
    state: 'armed',
    lastCheckedAt: '2026-08-28T10:01:00.000Z',
    lastReason: 'waiting its turn — 1st of 1 armed on acme/api',
    phase: 'queued_local',
    expiresAt: '2026-08-31T10:00:00.000Z',
    ...over,
  } as ArmedMergeRequest;
}

describe('the queued_local headline', () => {
  it('never phrases "1 of 1" as a wait — the row IS the head of that queue', () => {
    // The stale-phase window: the watcher wrote `queued_local` off a tick-start order in which
    // somebody was ahead; that somebody has since merged and the live index now says 1 of 1.
    const headline = armedPhaseHeadline(queuedLocal({ queuePosition: 1, queueDepth: 1 }));
    expect(headline).not.toContain('1 of 1');
    expect(headline).not.toContain('Waiting its turn —');
  });

  it('says nothing about a queue when the row now HOLDS the slot in a deeper one', () => {
    // Same staleness, four PRs armed: position 1 of 4 is still not a wait.
    const headline = armedPhaseHeadline(queuedLocal({ queuePosition: 1, queueDepth: 4 }));
    expect(headline).not.toContain('1 of 4');
    expect(headline).toBe('Next up on this repo');
  });

  it('still counts a REAL wait, where somebody is actually ahead', () => {
    expect(armedPhaseHeadline(queuedLocal({ queuePosition: 2, queueDepth: 5 }))).toBe(
      'Waiting its turn — 2 of 5 on this repo',
    );
  });

  it('keeps the yielded row’s own headline, which is about a human and not a turn', () => {
    // A yield is not a position: the PR needs its author. It wins over both branches above.
    expect(
      armedPhaseHeadline(
        queuedLocal({ queuePosition: 1, queueDepth: 1, yieldedForFailedChecks: true }),
      ),
    ).toBe('Waiting — checks failed, letting the next PR through');
  });

  it('falls back to the plain label when the row carries no position at all', () => {
    // A client-side row that predates the fields, or the one tick a queue-disabled intent spends
    // taking its place in the landing order. It IS waiting a turn; we just can't say which.
    expect(armedPhaseHeadline(queuedLocal())).toBe('Waiting its turn on this repo');
  });

  it('leaves every other phase alone', () => {
    expect(armedPhaseHeadline(queuedLocal({ phase: 'waiting_conflicts' }))).toBe(
      'Waiting — conflicts with the base branch',
    );
    expect(armedPhaseHeadline(queuedLocal({ phase: null }))).toBe('Waiting…');
  });
});
