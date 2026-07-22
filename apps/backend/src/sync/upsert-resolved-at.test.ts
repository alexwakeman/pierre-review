import { describe, expect, it } from 'vitest';
import { nextResolvedAt } from './upsert.js';

// nextResolvedAt decides a review thread's resolvedAt stamp each sync. It's the load-bearing bit
// of the resolution-latency feature: GitHub exposes no resolve timestamp, so we approximate it by
// the sync that first WITNESSES an unresolved→resolved flip — and must never (a) move a stamp once
// set, nor (b) invent a stamp for a thread that was already resolved when we first saw it.
const OBS = new Date('2026-07-20T12:00:00Z');
const EARLIER = new Date('2026-07-01T00:00:00Z');

describe('nextResolvedAt', () => {
  it('stamps observedAt on a witnessed unresolved→resolved transition', () => {
    expect(nextResolvedAt({ isResolved: false, resolvedAt: null }, true, OBS)).toBe(OBS);
  });

  it('leaves null while the thread stays unresolved', () => {
    expect(nextResolvedAt({ isResolved: false, resolvedAt: null }, false, OBS)).toBeNull();
  });

  it('leaves null for a thread already resolved the FIRST time we see it (no prior row)', () => {
    // Backfill / never-witnessed resolve: true resolution time unknowable → excluded, not stamped.
    expect(nextResolvedAt(undefined, true, OBS)).toBeNull();
  });

  it('leaves null for a prior-resolved thread that never got a stamp (already resolved at first sight)', () => {
    expect(nextResolvedAt({ isResolved: true, resolvedAt: null }, true, OBS)).toBeNull();
  });

  it('preserves an existing stamp (idempotent — never moves once set)', () => {
    expect(nextResolvedAt({ isResolved: true, resolvedAt: EARLIER }, true, OBS)).toBe(EARLIER);
  });

  it('preserves the stamp even if GitHub reports the thread re-opened then resolved again', () => {
    // resolvedAt is the FIRST observed resolution; a later unresolved snapshot keeps the original.
    expect(nextResolvedAt({ isResolved: false, resolvedAt: EARLIER }, true, OBS)).toBe(EARLIER);
  });
});
